var index = require("./app.spec")
import * as assert from 'assert';
import * as tl from "azure-pipelines-task-lib/task";
import * as mc from "mocha"
import * as ch from "chai"
import ttm = require('azure-pipelines-task-lib/mock-test')
import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

mc.describe('Mix Task', function () {
  ch.it('Task runs successfully', (done: mc.MochaDone) => {
    let taskPath = '../tasks/mix/index.js';
    let tr: ttm.MockTestRunner = new ttm.MockTestRunner(taskPath);
    tr.run();
    assert(tr.succeeded, "azure-arm-app-service-tests should have passed but failed.");    
    done()
  });
});

mc.describe('Serve Task', function () {
  ch.it('Task runs successfully', (done: mc.MochaDone) => {
    let taskPath = '../tasks/serve/index.js';
    let tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(taskPath);
    tr.setInput('recipeArtifact', './test.yml')
    tr.run()

    done()
  });
});