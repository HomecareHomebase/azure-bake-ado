import clitask from "./index"
import * from "mocha"
import * from "chai"

describe('clitask', function() {
    it('runMain', function() {
      let result = clitask.runMain()
      result.catch == null
    });
  });