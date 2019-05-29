const exec = require('child_process').exec;
const del = require('del');
const es = require('event-stream');
const filter = require('gulp-filter');
const fs = require('file-system');
const git = require('gulp-git');
const gulp = require('gulp');
const debug = require('gulp-debug');
const inlinesource = require('gulp-inline-source');
const moment = require('moment');
const params = require('./build/parameters');
const shell = require('gulp-shell');
const tag = require('gulp-tag-version');
const vstsBump = require('gulp-vsts-bump');

function bumpVersion() {
    return gulp.src(['tasks/**/task.json'], { base: './' })
        .pipe(vstsBump({ type: 'patch' }))
        .pipe(gulp.dest('./'));
}

function cleanCoverage() {
    return del('coverage/**', { force: true });
}

function gitAddCommit(done) {
    var branchName = params.buildSourceBranch;
    if (branchName !== 'master') {
        // all branches have refs/heads/ - we don't need that
        // we will also remove feature/ if it's there
        branchName = branchName.replace(/refs\/heads\/(feature\/)?/i, '');
    }
    
    var gitScript = `sudo git checkout ` + branchName + ` && 
    sudo git config --global user.email "` + params.buildRequestedForEmail + `" &&
    sudo git config --global user.name "` + params.buildRequestedFor + `"    
    sudo git add --a && 
    sudo git commit --author '` + params.buildRequestedFor + '<' + params.buildRequestedForEmail + `>' -m "[skip ci][CHORE] Update & Publish" && 
    sudo git push origin ` + branchName ` -q`;
    console.log('Git Script: ' + gitScript);
    return shell.task(gitScript)(done());
}
function tagVersion() {
    return gulp.src('./vss-extension.json').pipe(filter('vss-extension.json')).pipe(tag());
}

function inlineCoverageSource() {
    return gulp.src('./coverage/*.html')
        .pipe(inlinesource({ attribute: false }))
        .pipe(gulp.dest('./coverage/inline-html'));
}

function printVersion(done) {
    let name = require('./package.json').version;

    if (process.env.BUILD_REASON === 'PullRequest') {
        // pull requests will be [version]_[source branch name]
        const branchName = process.env.SYSTEM_PULLREQUEST_SOURCEBRANCH;
        name += '_' + branchName.replace(/refs\/heads\/(feature\/)?/i, '');
    } else if (process.env.BUILD_SOURCEBRANCHNAME) {
        const branchName = process.env.BUILD_SOURCEBRANCH;

        if (branchName !== 'master') {
            // all branches have refs/heads/ - we don't need that
            // we will also remove feature/ if it's there
            name += '_' + branchName.replace(/refs\/heads\/(feature\/)?/i, '');
        }
    }

    // make sure no illegal characters are there
    name = name.replace(/\"|\/|:|<|>|\\|\|\?|\@|\*/g, '_');

    // add YYYYMMDD_HHmm to mark the date and time of this build
    name += `_${moment().format('YYYYMMDD.HHmm')}`;

    console.log('##vso[build.updatebuildnumber]' + name);
    done();
}

function packageExtension(done) {
    var child = exec('sudo tfx extension create --root . --output-path ' + params.vsixDirectory + ' --manifest-globs vss-extension.json --rev-version');
    child.stdout.on('data', function (data) {
        console.log('stdout: ' + data);
    });
    child.stderr.on('data', function (data) {
        console.log('stderr: ' + data);
    });
    child.on('error', function (errors) {
        console.log('Comand Errors: ' + errors);
        done(errors);
    });
    child.on('close', function (code) {
        console.log('closing code: ' + code);
        done(null, code);
    });
}

function publishExtension(done) {
    var child = exec('sudo tfx extension publish --root . --share-with ' + process.env.ORGSHARE +' --token ' + process.env.VSMARKETPLACETOKEN + ' --output-path ' + params.vsixDirectory + ' --manifest-globs vss-extension.json --rev-version');
    child.stdout.on('data', function (data) {
        console.log('stdout: ' + data);
    });
    child.stderr.on('data', function (data) {
        console.log('stderr: ' + data);
    });
    child.on('error', function (errors) {
        console.log('Comand Errors: ' + errors);
        done(errors);
    });
    child.on('close', function (code) {
        console.log('closing code: ' + code);
        done(null, code);
    });
}

function setupCoveragePool() {
    return gulp.src("tasks/**/*.ts").pipe(writeFilenameToFile()).pipe(debug());
}

function sonarQube(done) {
	if (!parms.isRunningOnADO) {
		console.log('Skipping SonarQube analysis for local build...');
		done();
	}
	else {
		let version = require('./package.json').version;
		//standard SonarQube configuration options
		let sonarOptions = {
			"sonar.projectName": "Azure-Bake-ADO",
			"sonar.projectKey": "azure-bake-ado",
			"sonar.typescript.lcov.reportPaths": "coverage/lcov.info",
			"sonar.projectVersion": version,
			//"sonar.cpd.exclusions": "src/index.html, dist/index.html",
			"sonar.coverage.exclusions": "**/*.spec.ts, gulpfile.js, karma.conf.js, protractor.conf.js, **/node_modules/*"
		};

		//get source branch name
		let sourceBranch = (process.env.BUILD_REASON === 'PullRequest') ? process.env.SYSTEM_PULLREQUEST_SOURCEBRANCH : process.env.BUILD_SOURCEBRANCH;
		sourceBranch = sourceBranch.replace(/refs\/heads\//i, '');

		//if running from a pull request, add the target branch option
		if (process.env.BUILD_REASON === 'PullRequest') {
			sonarOptions["sonar.branch.target"] = process.env.SYSTEM_PULLREQUEST_TARGETBRANCH.replace(/refs\/heads\//i, '');
		}

		//if not running on the master branch, add the source branch option
		if (sourceBranch != 'master') {
			sonarOptions["sonar.branch.name"] = sourceBranch
		}

		sonarqubeScanner({
			serverUrl: "https://sonarqube.hchb.com",
			token: argv.sonarToken,
			options: sonarOptions
		}, done);
	}
}

function testNycMocha(done) {
    return shell.task(['nyc mocha --opts test/mocha.opts'])(done());
}

function tfxInstall(done) {
    var child = exec("sudo npm remove tfx-cli && sudo npm install --global tfx-cli");
    child.stdout.on('data', function (data) {
        console.log('stdout: ' + data);
    });
    child.stderr.on('data', function (data) {
        console.log('stderr: ' + data);
    });
    child.on('error', function (errors) {
        console.log('Comand Errors: ' + errors);
        done(errors);
    });
    child.on('close', function (code) {
        console.log('closing code: ' + code);
        done(null, code);
    });
}

function uploadExtension (done) {
    if (!params.isPullRequest && params.buildSourceBranch == 'master') {
        gulp.series(tfxInstall, bumpVersion, publishExtension, gitAddCommit, tagVersion)(done());
    }
    else { 
        console.log('Branch: ' + params.buildSourceBranch);
        done(null, 'Failed to Upload Extension'); }
}

function writeFilenameToFile() {
    let output = fs.createWriteStream(__dirname + '/test/app.spec.ts');
    output.write('// I am an automatically generated file. I help ensure that unit tests have accurate code coverage numbers. You can ignore me.\n\n')
    //Return event-stream map to the pipeline
    return es.map((file, cb) => {
        let name = file.history[0];
        if (name) {
            name = name.replace(__dirname + '.').replace(/\\/g, '/');
            output.write('require(\'' + name + '\');\n');
        }
        //Callback signals the operation is done and returns the object to the pipeline
        cb(null, file);
    });
}

function recipeDiff() {
	return gulp.src('components/**/*')
		.pipe(git.diff(params.pullRequestTargetBranch, { args: "--no-commit-id --name-only", log: true }))
		.pipe(gulp.dest(params.artifactsDirectory + '/recipes'));
}

//Tasks
exports.analysis = gulp.series(sonarQube);
exports.bump = bumpVersion;
exports.commit = gitAddCommit;
exports.cleancoverage = cleanCoverage;
exports.coverage = gulp.series(cleanCoverage, setupCoveragePool, testNycMocha);
exports.coveragesonarqube = gulp.series(cleanCoverage, setupCoveragePool, testNycMocha, sonarQube);
exports.inlinecoveragesource = inlineCoverageSource;
exports.package = gulp.series(tfxInstall, packageExtension);
exports.packageextension = packageExtension;
exports.pretest = gulp.series(cleanCoverage, setupCoveragePool);
exports.printversion = printVersion;
exports.setupcoveragepool = setupCoveragePool;
exports.tag = tagVersion;
exports.testnycmocha = testNycMocha;
exports.tfxinstall = tfxInstall;
exports.upload = uploadExtension;