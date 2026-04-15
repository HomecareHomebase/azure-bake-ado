import * as tl from "azure-pipelines-task-lib/task";
import * as path from 'path'
import * as fs from 'fs'
import { IExecOptions } from 'azure-pipelines-task-lib/toolrunner';
tl.setResourcePath(path.join(__dirname, 'task.json'));
//let docker = new dockerCLI.Docker()

export class clitask {

    public static async runMain() {

        try {
            const releaseDir: string = process.env.AGENT_RELEASEDIRECTORY as string //ADO defaults to this value for recipeArtifact
            const rootCaFile: string = tl.getInput('rootCaFile', false)
            const recipeName: string = tl.getInput('recipe', false)
            const recipeArtifact: string = (tl.getInput('recipeArtifact', false) === releaseDir) ? "" : tl.getInput('recipeArtifact', false)
            
            console.log("Is recipeArtifact specified:" + !(tl.getInput('recipeArtifact', false) === releaseDir))

            if (recipeName && recipeArtifact) {
                throw new Error('Both recipe and bake artifact file are defined, only one can be set')
            }

            if (!recipeArtifact && !recipeName) {
                throw new Error('One of recipe or bake artifact file must be defined')
            }

            this.setupCredentials()
            this.setupKubernetesConfig()
            this.setupEnvironment()

            await this.deployImage(recipeName, recipeArtifact, rootCaFile)
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            tl.setResult(tl.TaskResult.Failed, message);
        }

    }
    static async deployImage(recipe: string, recipeFile: string, rootCaFile: string | undefined | null = null): Promise<void> {

        if (recipeFile) {
            const contents = fs.readFileSync(recipeFile)
            recipe = contents.toString()
            console.log('Deploying Bake recipe via Artifact output | ' + recipe)
        }        

        recipe = recipe.toLowerCase()

        const execOptions = <IExecOptions> { failOnStdErr: true,
                            ignoreReturnCode: false } 
        
        const envFile = path.join(tl.getVariable('Agent.TempDirectory') || tl.getVariable('system.DefaultWorkingDirectory') || 'c:/temp/', 'bake.env')

        let envContent = "BAKE_ENV_NAME=" + (process.env.BAKE_ENV_NAME || "") + "\r\n" +
            "BAKE_ENV_CODE=" + (process.env.BAKE_ENV_CODE || "") + "\r\n" +
            "BAKE_ENV_REGIONS=" + (process.env.BAKE_ENV_REGIONS || "") + "\r\n" +
            "BAKE_AUTH_SUBSCRIPTION_ID=" + (process.env.BAKE_AUTH_SUBSCRIPTION_ID || "") + "\r\n" +
            "BAKE_AUTH_TENANT_ID=" + (process.env.BAKE_AUTH_TENANT_ID || "") + "\r\n" +
            "BAKE_AUTH_SERVICE_ID=" + (process.env.BAKE_AUTH_SERVICE_ID || "") + "\r\n" +
            "BAKE_AUTH_SERVICE_CERT=" + (process.env.BAKE_AUTH_SERVICE_CERT || "") + "\r\n" +
            "BAKE_AUTH_SERVICE_KEY=" + (process.env.BAKE_AUTH_SERVICE_KEY || "") + "\r\n" +
            "BAKE_AUTH_SKIP=" + (process.env.BAKE_AUTH_SKIP || "false") + "\r\n" +
            "BAKE_LOG_LEVEL=" + (process.env.BAKE_LOG_LEVEL || "info") + "\r\n" +
            `BAKE_VARIABLES=/app/bake/.env\r\n`

        if (rootCaFile){
            console.log('Injecting custom root CA File: ' + rootCaFile)
            envContent += 'NODE_EXTRA_CA_CERTS=/app/ca.crt\r\n'
        }

        fs.writeFileSync(envFile, envContent)

        //clear out current env vars now
        process.env.BAKE_ENV_NAME = process.env.BAKE_ENV_CODE = process.env.BAKE_ENV_REGIONS = process.env.BAKE_AUTH_SUBSCRIPTION_ID =
            process.env.BAKE_AUTH_TENANT_ID = process.env.BAKE_AUTH_SERVICE_ID = process.env.BAKE_AUTH_SERVICE_KEY = process.env.BAKE_AUTH_SERVICE_CERT =
            ""

        let exitCode = 0
        try {
            //we need to force pull the docker image, in case the tag was local already (but old content)
            await tl.tool('docker').arg('pull').arg(recipe).exec()

            const tool = tl.tool('docker')
            let args = tool.arg('run').arg('--rm').arg('-t')
                .arg('--env-file=' + envFile)
                .arg(`-v=${process.env.BAKE_VARIABLES}:/app/bake/.env:Z`)

            if (rootCaFile){
                args = args.arg(`-v=${rootCaFile}:/app/ca.crt:Z`)
            }

            const certHostPath = process.env.BAKE_AUTH_SERVICE_CERT_HOST_PATH
            if (certHostPath) {
                args = args.arg(`-v=${certHostPath}:/app/spnCert.pem:Z`)
            }

            exitCode = await args.arg(recipe).exec(execOptions)
        } catch (err) {
            console.error('Error during deployment: ' + err)
            exitCode = 2
        } finally {
            //clean up temp files
            try { fs.unlinkSync(envFile) } catch (_) { /* best-effort */ }
            try { fs.unlinkSync(process.env.BAKE_VARIABLES) } catch (_) { /* best-effort */ }

            //clean up SPN certificate file if it was written
            const certPath = process.env.BAKE_AUTH_SERVICE_CERT_HOST_PATH
            if (certPath) {
                try { fs.unlinkSync(certPath) } catch (_) { /* best-effort */ }
            }
        }

        if (exitCode !== 0) {
            throw new Error('Deployment Failed')
        }
    }

    static setupEnvironment(): void {
        let envName: string = tl.getInput('envName', false)
        let envCode: string = tl.getInput('envCode', false)
        let envRegions: string = tl.getInput('envRegions', false)
        const skipAzureConnection: boolean = tl.getBoolInput('skipAzureConnection');

        if (!envName) {
            envName = process.env.BAKE_ENV_NAME || ""
            if (!envName && !skipAzureConnection) {
                throw new Error("Environment Name is required");
            }
        }

        if (!envCode) {
            envCode = process.env.BAKE_ENV_CODE || ""
            if (!envCode && !skipAzureConnection) {
                throw new Error("Environment Code is required");
            }
        }

        if (!envRegions) {
            envRegions = process.env.BAKE_ENV_REGIONS || ""
            if (!envRegions && !skipAzureConnection) {
                throw new Error("Deployment Regions are required");
            }
        }

        //gather up all environment variables.
        const secretPrefixes = ["BAKE_", "ENDPOINT_", "INPUT_", "SECRET_", "SYSTEM_ACCESSTOKEN", "VSMARKETPLACETOKEN"]
        let bakeVars: string = ""
        for (const envvar in process.env) {
            const upperVar = envvar.toUpperCase()
            if (!secretPrefixes.some(prefix => upperVar.startsWith(prefix)))
                bakeVars += envvar + ": '" + process.env[envvar] + "'\n"
        }

        const bakeVarFile = path.join(tl.getVariable('Agent.TempDirectory') || tl.getVariable('system.DefaultWorkingDirectory') || 'c:/temp/', 'bake.vars')
        fs.writeFileSync(bakeVarFile, bakeVars)
        fs.chmodSync(bakeVarFile, 0o744)

        if (skipAzureConnection) {
            console.log('Setting azure-less environment')
        }
        else {
            console.log('Setting environment for %s (%s)', envName, envCode)
            process.env.BAKE_ENV_NAME = envName
            process.env.BAKE_ENV_CODE = envCode
            process.env.BAKE_ENV_REGIONS = envRegions
        }

        process.env.BAKE_VARIABLES = bakeVarFile
        
    }

    static setupKubernetesConfig(): void {
        const useKubernetes: boolean = tl.getBoolInput("useKubernetes", false)
        const configToken: string = tl.getInput("kubeConfigToken", false)

        if (!useKubernetes) {
            return
        }

        //curently, we integrate with current kuberenetes V1 task that sets a global env var of "KUBECONFIG" to the
        //path of the k8s config file with context already set (assume login command task run)

        //in future we might pull in the k8s connection code and setup the config ourselves.

        const kubeConfig = tl.getVariable("KUBECONFIG")
        if (!kubeConfig){
            tl.error("KUBECONFIG variable is not defined, can't bundle config file!")
            throw new Error("KUBECONFIG variable is not defined, can't bundle config file!")
        }

        if (!fs.existsSync(kubeConfig)) {
            tl.error(`${kubeConfig} doesn't exist, can't bundle config file!`)
            throw new Error(`${kubeConfig} doesn't exist, can't bundle config file!`)
        }

        if (!configToken){
            tl.error("Did not define a token for config data, can't bundle config file!")
            throw new Error("Did not define a token for config data, can't bundle config file!")
        }

        const data = fs.readFileSync(kubeConfig)
        const base64 = data.toString('base64')
        process.env[configToken] = base64
    }

    static setupCredentials(): void {

        //check if we should skip azure connection usage.
        const skipAzureConnection: boolean = tl.getBoolInput("skipAzureConnection")
        process.env.BAKE_AUTH_SKIP = skipAzureConnection.toString()
        if (skipAzureConnection){
            return
        }

        const connectedService: string = tl.getInput("azureConnection", true)

        const servicePrincipalId: string = tl.getEndpointAuthorizationParameter(connectedService, "serviceprincipalid", false)
        const authType: string = tl.getEndpointAuthorizationParameter(connectedService, 'authenticationType', true)
        let cliPasswordPath: string = ""
        let certHostPath: string = ""
        let servicePrincipalKey: string = ""
        if (authType === "spnCertificate") {
            tl.debug('certificate based endpoint')
            const certificateContent: string = tl.getEndpointAuthorizationParameter(connectedService, "servicePrincipalCertificate", false)
            certHostPath = path.join(tl.getVariable('Agent.TempDirectory') || tl.getVariable('system.DefaultWorkingDirectory'), 'spnCert.pem')
            fs.writeFileSync(certHostPath, certificateContent)
            cliPasswordPath = '/app/spnCert.pem'

        }
        else {
            tl.debug('key based endpoint')
            servicePrincipalKey = tl.getEndpointAuthorizationParameter(connectedService, "serviceprincipalkey", false)
        }

        const tenantId: string = tl.getEndpointAuthorizationParameter(connectedService, "tenantid", false)
        const subscriptionID: string = tl.getEndpointDataParameter(connectedService, "SubscriptionID", true)

        //assign to env vars so we can pass in later.
        process.env.BAKE_AUTH_SUBSCRIPTION_ID = subscriptionID
        process.env.BAKE_AUTH_TENANT_ID = tenantId
        process.env.BAKE_AUTH_SERVICE_ID = servicePrincipalId
        process.env.BAKE_AUTH_SERVICE_KEY = servicePrincipalKey
        process.env.BAKE_AUTH_SERVICE_CERT = cliPasswordPath
        process.env.BAKE_AUTH_SERVICE_CERT_HOST_PATH = certHostPath

        console.log('Setting up authentication for SUBID=%s TID=%s', subscriptionID, tenantId)

    }
}


clitask.runMain();
