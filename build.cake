//////////////////////////////////////////////////////////////////////
// ADDINS
//////////////////////////////////////////////////////////////////////

#addin nuget:?package=MagicChunks&version=2.0.0.119
#addin nuget:?package=Cake.Tfx&version=0.8.0
#addin nuget:?package=Cake.Npm&version=0.16.0

//////////////////////////////////////////////////////////////////////
// TOOLS
//////////////////////////////////////////////////////////////////////

#tool nuget:?package=gitreleasemanager&version=0.8.0
#tool nuget:?package=GitVersion.CommandLine&version=4.0.0

// Load other scripts.
#load "./build/parameters.cake"

//////////////////////////////////////////////////////////////////////
// PARAMETERS
//////////////////////////////////////////////////////////////////////

BuildParameters parameters = BuildParameters.GetParameters(Context, BuildSystem);
bool publishingError = false;
var taskDirectories = new [] {
    "./tasks/mix",
    "./tasks/serve"
};
var taskManifests = taskDirectories.Select(x => $"{x}/task.json");

///////////////////////////////////////////////////////////////////////////////
// SETUP / TEARDOWN
///////////////////////////////////////////////////////////////////////////////

Setup(context =>
{
    parameters.SetBuildVersion(
        BuildVersion.CalculatingSemanticVersion(
            context: Context,
            parameters: parameters
        )
    );

    // Increase verbosity?
    if(parameters.IsMasterBranch && (context.Log.Verbosity != Verbosity.Diagnostic)) {
        Information("Increasing verbosity to diagnostic.");
        context.Log.Verbosity = Verbosity.Diagnostic;
    }

    Information("Building version {0} of azure-bake-ado ({1}, {2}) using version {3} of Cake. (IsTagged: {4})",
        parameters.Version.SemVersion,
        parameters.Configuration,
        parameters.Target,
        parameters.Version.CakeVersion,
        parameters.IsTagged);
});

//////////////////////////////////////////////////////////////////////
// TASKS
//////////////////////////////////////////////////////////////////////

Task("Clean")
    .Does(() =>
{
    CleanDirectories(new[] { "./artifacts" });
});

Task("Build")
    .IsDependentOn("Clean")
    .DoesForEach(taskDirectories, (path) =>
{
    NpmInstall(settings =>
        settings.FromPath(path)
            .WithLogLevel(NpmLogLevel.Warn));

    Information("Starting execution of tsc using working directory {0}", path);

    var exitCode =
        StartProcess("cmd",
                new ProcessSettings {
                    Arguments = new ProcessArgumentBuilder()
                    .Append("/c")
                    .Append("tsc"),
                    WorkingDirectory = path
                });

    if (exitCode != 0)
    {
        throw new Exception("Error encountered when executing tsc");
    }
});

Task("Install-Tfx-Cli")
    .Does(() =>
{
    NpmInstall(settings =>
        settings.AddPackage("tfx-cli")
            .InstallGlobally()
            .FromPath(".")
            .WithLogLevel(NpmLogLevel.Warn));
});

Task("Create-Release-Notes")
    .Does(() =>
{
    GitReleaseManagerCreate(parameters.GitHub.Token, "HomecareHomebase", "azure-bake-ado", new GitReleaseManagerCreateSettings {
        Milestone         = parameters.Version.Milestone,
        Name              = parameters.Version.Milestone,
        Prerelease        = true,
        TargetCommitish   = "master"
    });
});

Task("Update-Task-Versions")
    .DoesForEach(taskManifests, (path) =>
{
    Information("Updating {0} version -> {1}", path, parameters.Version.SemVersion);

    TransformConfig(path, path, new TransformationCollection {
        { "version/Major", parameters.Version.Major }
    });

    TransformConfig(path, path, new TransformationCollection {
        { "version/Minor", parameters.Version.Minor }
    });

    TransformConfig(path, path, new TransformationCollection {
        { "version/Patch", parameters.Version.Patch }
    });
});

Task("Update-Json-Versions")
    .IsDependentOn("Update-Task-Versions")
    .Does(() =>
{
    var projectToPackagePackageJson = "vss-extension.json";
    Information("Updating {0} version -> {1}", projectToPackagePackageJson, parameters.Version.SemVersion);

    TransformConfig(projectToPackagePackageJson, projectToPackagePackageJson, new TransformationCollection {
        { "version", parameters.Version.SemVersion }
    });
});

Task("Package-Extension")
    .IsDependentOn("Build")
    .IsDependentOn("Update-Json-Versions")
    .IsDependentOn("Install-Tfx-Cli")
    .Does(() =>
{
    var artifactsDir = Directory("./artifacts");

    TfxExtensionCreate(new TfxExtensionCreateSettings()
    {
        ManifestGlobs = new List<string>(){ "./vss-extension.json" },
        OutputPath = artifactsDir
    });
});

Task("Upload-Artifacts")
    .WithCriteria(() => TFBuild.IsRunningOnAzurePipelinesHosted)
    .IsDependentOn("Package-Extension")
    .Does(() =>
{
    TFBuild.Commands.UploadArtifactDirectory("./artifacts");
});

Task("Publish-GitHub-Release")
    .WithCriteria(() => parameters.ShouldPublish)
    .Does(() =>
{
    var artifactsDir = Directory("./artifacts");
    var packageFile = File($"HomecareHomebase.azure-bake-{parameters.Version.SemVersion}.vsix");

    GitReleaseManagerAddAssets(parameters.GitHub.Token, "HomecareHomebase", "azure-bake-ado", parameters.Version.Milestone, artifactsDir + packageFile);
    GitReleaseManagerClose(parameters.GitHub.Token, "HomecareHomebase", "azure-bake-ado", parameters.Version.Milestone);
})
.OnError(exception =>
{
    Information("Publish-GitHub-Release Task failed, but continuing with next Task...");
    publishingError = true;
});

Task("Publish-Extension")
    .IsDependentOn("Package-Extension")
    .WithCriteria(() => parameters.ShouldPublish)
    .Does(() =>
{
    var artifactsDir = Directory("./artifacts");
    var packageFile = File($"HomecareHomebase.azure-bake-{parameters.Version.SemVersion}.vsix");

    TfxExtensionPublish(artifactsDir + packageFile, new TfxExtensionPublishSettings()
    {
        AuthType = TfxAuthType.Pat,
        Token = parameters.Marketplace.Token
    });
})
.OnError(exception =>
{
    Information("Publish-Extension Task failed, but continuing with next Task...");
    publishingError = true;
});

//////////////////////////////////////////////////////////////////////
// TASK TARGETS
//////////////////////////////////////////////////////////////////////

Task("Default")
    .IsDependentOn("Package-Extension");

Task("VSTS")
    .IsDependentOn("Upload-Artifacts")
    .IsDependentOn("Publish-Extension")
    .IsDependentOn("Publish-GitHub-Release")
    .Finally(() =>
{
    if(publishingError)
    {
        throw new Exception("An error occurred during the publishing of azure-bake-ado.  All publishing tasks have been attempted.");
    }
});

Task("ReleaseNotes")
  .IsDependentOn("Create-Release-Notes");

//////////////////////////////////////////////////////////////////////
// EXECUTION
//////////////////////////////////////////////////////////////////////

RunTarget(parameters.Target);