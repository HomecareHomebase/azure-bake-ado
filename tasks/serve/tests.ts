import { clitask } from "./index"
import mocha = require("mocha");
import chai = require('chai');

describe('clitask', function() {
    it('runMain', function() {
      let result = clitask.runMain()
      result.catch == null
    });
  });