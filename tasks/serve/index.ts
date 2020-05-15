import * as tl from "azure-pipelines-task-lib/task";
import * as path from 'path'
import * as fs from 'fs'
import { Buffer } from 'buffer'
import { IExecOptions } from 'azure-pipelines-task-lib/toolrunner';
tl.setResourcePath(path.join(__dirname, 'task.json'));
//let docker = new dockerCLI.Docker()

export class clitask {

    public static async runMain() {

        try {
            let releaseDir: string = process.env.AGENT_RELEASEDIRECTORY as string //ADO defaults to this value for recipeArtifact
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

            this.deployImage(recipeName, recipeArtifact, rootCaFile)
        } catch (err) {
            tl.setResult(tl.TaskResult.Failed, err.message);
        }

    }
    static deployImage(recipe: string, recipeFile: string, rootCaFile: string | undefined | null = null): void {

        if (recipeFile) {
            let contents = fs.readFileSync(recipeFile)
            recipe = contents.toString()
            console.log('Deploying Bake recipe via Artifact output | ' + recipe)
        }        

        recipe = recipe.toLocaleLowerCase()

        /*RegEx to determine if it is local or remote Docker Registry
        let remoteRegistry = recipe.match(/(.*)[\/.*]/)
        let login = tl.tool('docker')

        if (remoteRegistry && !recipeFile) {
            console.log("Logging into registry at: " + remoteRegistry[1])
            let l = login.arg('login -u ' + process.env.BAKE_AUTH_SERVICE_ID + ' -p ' + process.env.BAKE_AUTH_SERVICE_KEY + ' ' + remoteRegistry[1]).exec()        
        }*/
        
       // let dockerindocker: boolean = tl.getBoolInput('dockerindocker') 
        var _execOptions = <IExecOptions> { failOnStdErr: true,
                            ignoreReturnCode: false } 
        
        let envFile = path.join(tl.getVariable('Agent.TempDirectory') || tl.getVariable('system.DefaultWorkingDirectory') || 'c:/temp/', 'bake.env')

        let envContent = "BAKE_ENV_NAME=" + (process.env.BAKE_ENV_NAME || "") + "\r\n" +
            "BAKE_ENV_CODE=" + (process.env.BAKE_ENV_CODE || "") + "\r\n" +
            "BAKE_ENV_REGIONS=" + (process.env.BAKE_ENV_REGIONS || "") + "\r\n" +
            "BAKE_AUTH_SUBSCRIPTION_ID=" + (process.env.BAKE_AUTH_SUBSCRIPTION_ID || "") + "\r\n" +
            "BAKE_AUTH_TENANT_ID=" + (process.env.BAKE_AUTH_TENANT_ID || "") + "\r\n" +
            "BAKE_AUTH_SERVICE_ID=" + (process.env.BAKE_AUTH_SERVICE_ID || "") + "\r\n" +
            "BAKE_AUTH_SERVICE_CERT=" + (process.env.BAKE_AUTH_SERVICE_CERT || "") + "\r\n" +
            "BAKE_AUTH_SERVICE_KEY=" + (process.env.BAKE_AUTH_SERVICE_KEY || "") + "\r\n" +
            "BAKE_AUTH_SKIP=" + (process.env.BAKE_AUTH_SKIP || "false") + "\r\n" +
            `BAKE_VARIABLES=/app/bake/.env\r\n`

        if (rootCaFile){
            console.log('Injecting custom root CA File: ' + rootCaFile)
            envContent += 'NODE_EXTRA_CA_CERTS=/app/ca.crt\r\n'
        }

        fs.writeFileSync(envFile, envContent)

        //clear out current env vars now
        process.env.BAKE_ENV_NAME = process.env.BAKE_ENV_CODE = process.env.BAKE_ENV_REGIONs = process.env.BAKE_AUTH_SUBSCRIPTION_ID =
            process.env.BAKE_AUTH_TENANT_ID = process.env.BAKE_AUTH_SERVICE_ID = process.env.BAKE_AUTH_SERVICE_KEY = process.env.BAKE_AUTH_SERVICE_CERT =
            ""
        
        //we need to force pull the docker image, in case the tag was local already (but old content)
        let p = tl.tool('docker').arg('pull').arg(recipe).exec()        
        p.then(()=>{
            let tool = tl.tool('docker')

            let args = tool.arg('run').arg('--rm').arg('-t')
                .arg('--env-file=' + envFile)
                .arg(`-v=${process.env.BAKE_VARIABLES}:/app/bake/.env:Z`)
            
            if (rootCaFile){
                args = args.arg(`-v=${rootCaFile}:/app/ca.crt:Z`)
            }

            p = args.arg(recipe)
                .exec(_execOptions) 
            p.then((code) => {
                this.cleanupAndExit(envFile, process.env.BAKE_VARIABLES, code)
            }, (err) => {
                this.cleanupAndExit(envFile, process.env.BAKE_VARIABLES, 2)
            })            
        }, (err)=>{
            console.error('Error pulling image : ' + err)
            this.cleanupAndExit(envFile, process.env.BAKE_VARIABLES, 2)
        })
    }

    static cleanupAndExit(envFile: string, bakeVars: string, exitCode: number) {
        fs.unlinkSync(envFile)
        fs.unlinkSync(bakeVars)
        if (exitCode != 0) {
            tl.setResult(tl.TaskResult.Failed, "Deployment Failed");
            process.exit(exitCode)
        }
    }

    static setupEnvironment(): void {
        let envName: string = tl.getInput('envName', false)
        let envCode: string = tl.getInput('envCode', false)
        let envRegions: string = tl.getInput('envRegions', false)
        let skipAzureConnection: boolean = tl.getBoolInput('skipAzureConnection');

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
        let bakeVars: string = ""
        for (let envvar in process.env) {
            if (!envvar.toLocaleUpperCase().startsWith("BAKE_") &&
                !envvar.toLocaleUpperCase().startsWith("ENDPOINT_") &&
                !envvar.toLocaleUpperCase().startsWith("INPUT_"))
                bakeVars += envvar + ": '" + process.env[envvar] + "'\n"
        }

        let bakeVarFile = path.join(tl.getVariable('Agent.TempDirectory') || tl.getVariable('system.DefaultWorkingDirectory') || 'c:/temp/', 'bake.vars')
        fs.writeFileSync(bakeVarFile, bakeVars)
        fs.chmodSync(bakeVarFile, 744)

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
        let useKubernetes: boolean = tl.getBoolInput("useKubernetes", false)
        let configToken: string = tl.getInput("kubeConfigToken", false)

        if (!useKubernetes) {
            return
        }

        //curently, we integrate with current kuberenetes V1 task that sets a global env var of "KUBECONFIG" to the
        //path of the k8s config file with context already set (assume login command task run)

        //in future we might pull in the k8s connection code and setup the config ourselves.

        let kubeConfig = tl.getVariable("KUBECONFIG")
        if (!kubeConfig){
            tl.error("KUBECONFIG variable is not defined, can't bundle config file!")
            throw new Error()
        }

        if (!fs.existsSync(kubeConfig)) {
            tl.error("$(kubeConfig) doesn't exist, can't bundle config file!")
            throw new Error()
        }

        if (!configToken){
            tl.error("Did not define a token for config data, can't bundle config file!")
            throw new Error()
        }

        let data = fs.readFileSync(kubeConfig)
        let base64 = data.toString('base64')
        process.env[configToken] = base64
    }

    static setupCredentials(): void {

        //check if we should skip azure connection usage.
        var skipAzureConnection: boolean = tl.getBoolInput("skipAzureConnection")
        process.env.BAKE_AUTH_SKIP = skipAzureConnection.toString()
        if (skipAzureConnection){
            return
        }

        var connectedService: string = tl.getInput("azureConnection", true)

        let servicePrincipalId: string = tl.getEndpointAuthorizationParameter(connectedService, "serviceprincipalid", false)
        let authType: string = tl.getEndpointAuthorizationParameter(connectedService, 'authenticationType', true)
        let cliPassword: string = ""
        let cliPasswordPath: string = ""
        let servicePrincipalKey: string = ""
        if (authType == "spnCertificate") {
            tl.debug('certificate based endpoint')
            let certificateContent: string = tl.getEndpointAuthorizationParameter(connectedService, "servicePrincipalCertificate", false)
            cliPassword = path.join(tl.getVariable('Agent.TempDirectory') || tl.getVariable('system.DefaultWorkingDirectory'), 'spnCert.pem')
            fs.writeFileSync(cliPassword, certificateContent)
            cliPasswordPath = cliPassword

        }
        else {
            tl.debug('key based endpoint')
            cliPassword = tl.getEndpointAuthorizationParameter(connectedService, "serviceprincipalkey", false)
            servicePrincipalKey = cliPassword
        }

        var tenantId: string = tl.getEndpointAuthorizationParameter(connectedService, "tenantid", false)
        var subscriptionID: string = tl.getEndpointDataParameter(connectedService, "SubscriptionID", true)

        //assign to env vars so we can pass in later.
        process.env.BAKE_AUTH_SUBSCRIPTION_ID = subscriptionID
        process.env.BAKE_AUTH_TENANT_ID = tenantId
        process.env.BAKE_AUTH_SERVICE_ID = servicePrincipalId
        process.env.BAKE_AUTH_SERVICE_KEY = servicePrincipalKey
        process.env.BAKE_AUTH_SERVICE_CERT = cliPasswordPath

        console.log('Setting up authentication for SUBID=%s TID=%s', subscriptionID, tenantId)

    }
}


clitask.runMain();
