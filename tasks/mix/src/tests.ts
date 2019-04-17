import { clitask } from "./index"
import "mocha"
import "chai"

describe('clitask', function() {
    it('runMain', function() {
      let result = clitask.runMain()
      result.catch == null
    });
  });