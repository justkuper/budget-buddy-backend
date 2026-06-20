'use strict';

const { validationResult } = require('express-validator');

/**
 * Run express-validator checks and short-circuit with 400 if any fail.
 * Usage: router.post('/path', [...validators], validate, handler)
 */
function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  next();
}

module.exports = { validate };
