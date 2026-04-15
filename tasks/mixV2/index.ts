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

            const registryType = tl.getInput("containerregistrytype", true);
            let authenticationProvider : AuthenticationTokenProvider;


            if(registryType ===  "Azure Container Registry"){
                authenticationProvider =
                    new ACRAuthenticationTokenProvider(tl.getInput("azureSubscriptionEndpoint"), tl.getInput("azureContainerRegistry"));
            }
            else {
                authenticationProvider =
                    new GenericAuthenticationTokenProvider(tl.getInput("dockerRegistryEndpoint"));
            }

            const registryAuthenticationToken = authenticationProvider.getAuthenticationToken();

            // Connect to the configured registry using the default/local container host
            const connection = new ContainerConnection();
            connection.open(undefined, registryAuthenticationToken);

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

            const imageName = this.getImageName()
            const imageNames = [imageName]
            let imageMappings = this.getImageMappings(connection, imageNames, tags);

            if (useArtifact && useLatestTag){

                const tmpTags: string[] = new Array<string>()
                const tmpImageMappings = this.getImageMappings(connection, imageNames, tmpTags)
                if (tmpImageMappings.length === 1)
                    throw new Error('There are no source code tags to use as the artifact tag')

                artifactTag = tmpImageMappings[1].targetImageName
            }
            else if (useArtifact){
                //fix up the input image name to include registry if needed, etc.
                const qualifyImageName = tl.getBoolInput("qualifyImageName");
                artifactTag = imageUtils.imageNameWithoutTag(imageName) + ":" + artifactTag
                artifactTag = qualifyImageName ? connection.qualifyImageName(artifactTag) : artifactTag;
            }


            const tmpDir = tl.getVariable('agent.tempdirectory')
            const toolPath = path.join(tmpDir, 'bake')
            const bakePackagePath = path.join(toolPath, 'node_modules', 'azure-bake', 'package.json')
            const bakePackageName = 'azure-bake@' + runtimeVersion

            console.log('Installing Bake cli tool')
            if (!fs.existsSync(toolPath)) {
                tl.mkdirP(toolPath)
            }

            let installBake = true
            if (fs.existsSync(bakePackagePath)) {
                const installedBakePackage = JSON.parse(fs.readFileSync(bakePackagePath, 'utf8'))
                installBake = installedBakePackage.version !== runtimeVersion
            }

            if (installBake) {
                const installResult = tl.execSync('npm', 'install ' + bakePackageName,<IExecOptions>{
                    cwd : toolPath,
                    silent: true
                })

                if (installResult.code !== 0) {
                    const installError = installResult.stderr || installResult.stdout || ('exit code ' + installResult.code);
                    throw new Error('Failed to install ' + bakePackageName + ': ' + installError);
                }
            }

            //executing bake mix
            const bakeExecutable = process.platform === 'win32'
                ? path.join(toolPath, 'node_modules', '.bin', 'bake.cmd')
                : path.join(toolPath, 'node_modules', '.bin', 'bake')
            const bakeTool = tl.tool(bakeExecutable)
            const code = await bakeTool.arg('mix')
                .arg('--runtime='+runtimeVersion)
                .arg('--name='+imageName)
                .arg(bakeFile)
                .exec(<IExecOptions>{
                    cwd : toolPath
                })

            if (code !== 0) {
                throw new Error('Bake mix failed with exit code ' + code)
            }

            //tag the base image
            console.log('Tagging bake recipe')

            const firstMapping = imageMappings.shift() || <ImageMapping>{};
            await this.dockerTag(connection, firstMapping.sourceImageName, firstMapping.targetImageName);
            for (const mapping of imageMappings) {
                await this.dockerTag(connection, mapping.sourceImageName, mapping.targetImageName);
            }

            //push all tags
            console.log('Pushing bake recipe to remote registry')

            imageMappings = this.getImageMappings(connection, imageNames, tags);
            const firstImageMapping = imageMappings.shift() || <ImageMapping>{};
            await this.dockerPush(connection, firstImageMapping.targetImageName);
            for (const imageMapping of imageMappings) {
                await this.dockerPush(connection, imageMapping.targetImageName);
            }

            //write the artifact file if set.
            if (useArtifact){
                artifactTag = artifactTag.toLowerCase();
                console.log('Generating artifact file against image tag ' + artifactTag)

                tl.mkdirP(artifactOutput)
                const artifactFile = path.join(artifactOutput, 'bake.artifact')
                tl.writeFile(artifactFile,artifactTag)
            }

        } catch (err){
            console.error(err)
            const message = err instanceof Error ? err.message : String(err);
            tl.setResult(tl.TaskResult.Failed, message);
        }
    }

    static getImageName(): string {
        const imageName = tl.getInput("imageName", true);
        return imageUtils.generateValidImageName(imageName);
    }

    static getImageMappings(connection: ContainerConnection, imageNames: string[], additionalImageTags: string[]): ImageMapping[] {
        const qualifyImageName = tl.getBoolInput("qualifyImageName");
        const imageInfos: ImageInfo[] = imageNames.map(imageName => {
            const qualifiedImageName = qualifyImageName ? connection.qualifyImageName(imageName) : imageName;
            return {
                sourceImageName: imageName,
                qualifiedImageName: qualifiedImageName,
                baseImageName: imageUtils.imageNameWithoutTag(qualifiedImageName),
                taggedImages: []
            };
        });

        const includeSourceTags = tl.getBoolInput("includeSourceTags");

        let sourceTags: string[] = [];
        if (includeSourceTags) {
            sourceTags = sourceUtils.getSourceTags();
        }

        // For each of the image names, generate a mapping from the source image name to the target image.  The same source image name
        // may be listed more than once if there are multiple tags.  The target image names will be tagged based on the task configuration.
        for (let i = 0; i < imageInfos.length; i++) {
            const imageInfo = imageInfos[i];
            imageInfo.taggedImages.push(imageInfo.qualifiedImageName);
            sourceTags.forEach(tag => {
                imageInfo.taggedImages.push(imageInfo.baseImageName + ":" + tag);
            });
            additionalImageTags.forEach(tag => {
                imageInfo.taggedImages.push(imageInfo.baseImageName + ":" + tag);
            });
        }

        // Flatten the image infos into a mapping between the source images and each of their tagged target images
        const sourceToTargetMapping: ImageMapping[] = [];
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
        const command = connection.createCommand();
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
