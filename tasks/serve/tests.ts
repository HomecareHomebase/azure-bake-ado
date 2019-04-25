var index = require("./index")
import * as tl from "azure-pipelines-task-lib/task";
import "mocha"
import { expect } from "chai"
    
import ma = require('azure-pipelines-task-lib/mock-answer');
import tmrm = require('azure-pipelines-task-lib/mock-run');
import path = require('path');

describe('Serve Task', function() {
  it('Task runs successfully', (done:MochaDone) => {
      //let taskPath = path.join(__dirname, 'index.js');
      let taskPath = require.resolve("./index.js")
      let tr : tmrm.TaskMockRunner = new tmrm.TaskMockRunner(taskPath);
      tr.setInput("containerregistrytype", "docker")
      tr.run()
      
      done()
  });
});