import * as tl from "azure-pipelines-task-lib/task";
import ContainerConnection from "docker-common/containerconnection";
import AuthenticationTokenProvider  from "docker-common/registryauthenticationprovider/authenticationtokenprovider"
import ACRAuthenticationTokenProvider from "docker-common/registryauthenticationprovider/acrauthenticationtokenprovider"
import GenericAuthenticationTokenProvider from "docker-common/registryauthenticationprovider/genericauthenticationtokenprovider"
import * as imageUtils from "docker-common/containerimageutils"
import * as sourceUtils from "docker-common/sourceutils"
import * as path from 'path'
import * as fs from 'fs'
import { IExecOptions } from 'azure-pipelines-task-lib/toolrunner';

tl.setResourcePath(path.join(__dirname, 'task.json'));

export class clitask {

    public static async runMain(){

        try{

            let registryType = tl.getInput("containerregistrytype", true);
            let authenticationProvider : AuthenticationTokenProvider;


            if(registryType ==  "Azure Container Registry"){
                authenticationProvider =
                    new ACRAuthenticationTokenProvider(tl.getInput("azureSubscriptionEndpoint"), tl.getInput("azureContainerRegistry"));
            }
            else {
                authenticationProvider =
                    new GenericAuthenticationTokenProvider(tl.getInput("dockerRegistryEndpoint"));
            }

            let registryAuthenticationToken = authenticationProvider.getAuthenticationToken();

            // Connect to any specified container host and/or registry
            const connection = new ContainerConnection();
            connection.open(tl.getInput("dockerHostEndpoint"), registryAuthenticationToken);

            const runtimeVersion: string = tl.getInput('runtimeVersion', true)
            const bakeFile: string = tl.getInput('bakeFile', true)
            const tags: string[] = tl.getDelimitedInput('tags', '\n')
            const useArtifact: boolean = tl.getBoolInput('useArtifact')

            let artifactOutput: string = ""
            let artifactTag: string = ""
            let useLatestTag: boolean = false
            if (useArtifact){
                artifactOutput = tl.getInput('artifactOutput')
                artifactTag = tl.getInput('artifactTag')
                useLatestTag = tl.getBoolInput('useLatestTag')

                if (!artifactOutput) {
                    throw new Error('Output folder for bake artifact must be set')
                }

                if (!useLatestTag && !artifactTag) {
                    throw new Error('Either the latest git tag or a specific tag must be defined')
                }
            }

            let imageName = this.getImageName()
            let imageNames = [imageName]
            let imageMappings = this.getImageMappings(connection, imageNames, tags);

            if (useArtifact && useLatestTag){

                let tmpTags: string[] = new Array<string>()
                let tmpImageMappings = this.getImageMappings(connection, imageNames, tmpTags)
                if (tmpImageMappings.length == 1)
                    throw new Error('There are no source code tags to use as the artifact tag')

                artifactTag = tmpImageMappings[1].targetImageName
            }
            else if (useArtifact){
                //fix up the input image name to include registry if needed, etc.
                let qualifyImageName = tl.getBoolInput("qualifyImageName");
                artifactTag = imageUtils.imageNameWithoutTag(imageName) + ":" + artifactTag
                artifactTag = qualifyImageName ? connection.qualifyImageName(artifactTag) : artifactTag;
            }


            let tmpDir = tl.getVariable('agent.tempdirectory')
            let toolPath = path.join(tmpDir, 'bake')

            console.log('Installing Bake cli tool')
            if (!fs.existsSync(toolPath)) {
                tl.mkdirP(toolPath)
            }

            const installResult = tl.execSync('npm', 'install azure-bake',<IExecOptions>{
                cwd : toolPath,
                silent: true
            })

            if (installResult.code !== 0) {
                const installError = installResult.stderr || installResult.stdout || ('exit code ' + installResult.code);
                throw new Error('Failed to install azure-bake: ' + installError);
            }

            //executing bake mix
            let bakeTool = tl.tool('npx')
            let code = await bakeTool.arg('bake').arg('mix')
                .arg('--runtime='+runtimeVersion)
                .arg('--name='+imageName)
                .arg(bakeFile)
                .exec(<IExecOptions>{
                    cwd : toolPath
                })

            if (code != 0) {
                throw new Error('Bake mix failed with exit code ' + code)
            }

            //tag the base image
            console.log('Tagging bake recipe')

            let firstMapping = imageMappings.shift() || <ImageMapping>{};
            await this.dockerTag(connection, firstMapping.sourceImageName, firstMapping.targetImageName);
            for (const mapping of imageMappings) {
                await this.dockerTag(connection, mapping.sourceImageName, mapping.targetImageName);
            }

            //push all tags
            console.log('Pushing bake recipe to remote registry')

            imageMappings = this.getImageMappings(connection, imageNames, tags);
            let firstImageMapping = imageMappings.shift() || <ImageMapping>{};
            await this.dockerPush(connection, firstImageMapping.targetImageName);
            for (const imageMapping of imageMappings) {
                await this.dockerPush(connection, imageMapping.targetImageName);
            }

            //write the artifact file if set.
            if (useArtifact){
                artifactTag = artifactTag.toLowerCase();
                console.log('Generating artifact file against image tag ' + artifactTag)

                tl.mkdirP(artifactOutput)
                let artifactFile = path.join(artifactOutput, 'bake.artifact')
                tl.writeFile(artifactFile,artifactTag)
            }

        } catch (err){
            console.error(err)
            tl.setResult(tl.TaskResult.Failed, err.message);
        }
    }

    static getImageName(): string {
        const imageName = tl.getInput("imageName", true);
        return imageUtils.generateValidImageName(imageName);
    }

    static getImageMappings(connection: ContainerConnection, imageNames: string[], additionalImageTags: string[]): ImageMapping[] {
        let qualifyImageName = tl.getBoolInput("qualifyImageName");
        let imageInfos: ImageInfo[] = imageNames.map(imageName => {
            let qualifiedImageName = qualifyImageName ? connection.qualifyImageName(imageName) : imageName;
            return {
                sourceImageName: imageName,
                qualifiedImageName: qualifiedImageName,
                baseImageName: imageUtils.imageNameWithoutTag(qualifiedImageName),
                taggedImages: []
            };
        });

        let includeSourceTags = tl.getBoolInput("includeSourceTags");

        let sourceTags: string[] = [];
        if (includeSourceTags) {
            sourceTags = sourceUtils.getSourceTags();
        }

        // For each of the image names, generate a mapping from the source image name to the target image.  The same source image name
        // may be listed more than once if there are multiple tags.  The target image names will be tagged based on the task configuration.
        for (let i = 0; i < imageInfos.length; i++) {
            let imageInfo = imageInfos[i];
            imageInfo.taggedImages.push(imageInfo.qualifiedImageName);
            sourceTags.forEach(tag => {
                imageInfo.taggedImages.push(imageInfo.baseImageName + ":" + tag);
            });
            additionalImageTags.forEach(tag => {
                imageInfo.taggedImages.push(imageInfo.baseImageName + ":" + tag);
            });
        }

        // Flatten the image infos into a mapping between the source images and each of their tagged target images
        let sourceToTargetMapping: ImageMapping[] = [];
        imageInfos.forEach(imageInfo => {
            imageInfo.taggedImages.forEach(taggedImage => {
                sourceToTargetMapping.push({
                    sourceImageName: imageInfo.sourceImageName,
                    targetImageName: taggedImage
                });
            });
        });

        return sourceToTargetMapping;
    }

    static dockerTag(connection: ContainerConnection, sourceImage: string, targetImage: string): Promise<void> {
        let command = connection.createCommand();
        command.arg("tag");
        command.arg(sourceImage);
        command.arg(targetImage);

        tl.debug(`Tagging image ${sourceImage} with ${targetImage}.`);
        return connection.execCommand(command);
    }

    static dockerPush(connection: ContainerConnection, image: string): Promise<void> {
        const command = connection.createCommand();
        command.arg("push");
        command.arg(image);

        return connection.execCommand(command);
    }
}


interface ImageInfo {
    sourceImageName: string;
    qualifiedImageName: string;
    baseImageName: string;
    taggedImages: string[];
}

interface ImageMapping {
    sourceImageName: string;
    targetImageName: string;
}



clitask.runMain();
