#load "./version.cake"

public class BuildParameters
{
    public string Target { get; private set; }
    public string Configuration { get; private set; }
    public bool IsLocalBuild { get; private set; }
    public bool IsRunningOnUnix { get; private set; }
    public bool IsRunningOnWindows { get; private set; }
    public bool IsRunningOnAdo { get; private set; }
    public bool IsPullRequest { get; private set; }
    public bool IsMasterRepo { get; private set; }
    public bool IsMasterBranch { get; private set; }
    public bool IsTagged { get; private set; }
    public bool IsPublishBuild { get; private set; }
    public bool IsReleaseBuild { get; private set; }
    public bool SkipGitVersion { get; private set; }
    public BuildCredentials GitHub { get; private set; }
    public VisualStudioMarketplaceCredentials Marketplace { get; private set; }
    public BuildVersion Version { get; private set; }

    public bool ShouldPublish
    {
        get
        {
            return !IsLocalBuild && !IsPullRequest && IsMasterRepo
                && IsMasterBranch && IsTagged;
        }
    }

    public void SetBuildVersion(BuildVersion version)
    {
        Version  = version;
    }

    public static BuildParameters GetParameters(
        ICakeContext context,
        BuildSystem buildSystem
        )
    {
        if (context == null)
        {
            throw new ArgumentNullException("context");
        }

        var target = context.Argument("target", "Default");

        return new BuildParameters {
            Target = target,
            Configuration = context.Argument("configuration", "Release"),
            IsLocalBuild = buildSystem.IsLocalBuild,
            IsRunningOnUnix = context.IsRunningOnUnix(),
            IsRunningOnWindows = context.IsRunningOnWindows(),
            IsRunningOnAdo = buildSystem.TFBuild.IsRunningOnAzurePipelinesHosted,
            IsPullRequest = buildSystem.TFBuild.Environment.PullRequest.IsPullRequest,
            IsMasterRepo = StringComparer.OrdinalIgnoreCase.Equals("HomecareHomebase/azure-bake-ado", buildSystem.TFBuild.Environment.Repository.RepoName),
            IsMasterBranch = StringComparer.OrdinalIgnoreCase.Equals("master", buildSystem.TFBuild.Environment.Repository.Branch),
            IsTagged =  buildSystem.TFBuild.Environment.Repository.SourceBranch.StartsWith("refs/tags/", true, System.Globalization.CultureInfo.InvariantCulture),
            GitHub = new BuildCredentials (
                token: context.EnvironmentVariable("GITHUB_TOKEN")
            ),
            Marketplace = new VisualStudioMarketplaceCredentials (
                token: context.EnvironmentVariable("VS_MARKETPLACE_TOKEN")
            ),
            IsPublishBuild = new [] {
                "ReleaseNotes",
                "Create-Release-Notes"
            }.Any(
                releaseTarget => StringComparer.OrdinalIgnoreCase.Equals(releaseTarget, target)
            ),
            IsReleaseBuild = new string[] {
            }.Any(
                publishTarget => StringComparer.OrdinalIgnoreCase.Equals(publishTarget, target)
            ),
            SkipGitVersion = StringComparer.OrdinalIgnoreCase.Equals("True", context.EnvironmentVariable("SKIP_GITVERSION"))
        };
    }
}

public class BuildCredentials
{
    public string Token { get; private set; }

    public BuildCredentials(string token)
    {
        Token = token;
    }
}

public class VisualStudioMarketplaceCredentials
{
    public string Token { get; private set; }

    public VisualStudioMarketplaceCredentials(string token)
    {
        Token = token;
    }
}