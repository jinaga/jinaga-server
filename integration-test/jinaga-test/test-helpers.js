const { SpecificationParser, SpecificationOf } = require("jinaga");

function parseSpecification(input) {
  const parser = new SpecificationParser(input);
  parser.skipWhitespace();
  const spec = parser.parseSpecification();
  return new SpecificationOf(spec);
}

module.exports = {
  parseSpecification
};