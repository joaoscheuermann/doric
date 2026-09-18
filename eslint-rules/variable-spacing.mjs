const unwrap = (statement) => statement.declaration ?? statement;

const definesFunction = (node) =>
  node.declarations.some((declaration) =>
    ['ArrowFunctionExpression', 'FunctionExpression'].includes(
      declaration.init?.type,
    ),
  );

const needsSeparation = (previous, node) =>
  node.loc.end.line - node.loc.start.line >= 2 ||
  (definesFunction(unwrap(previous)) && definesFunction(node));

function paddingGaps(source, previous, statement) {
  const boundaries = [
    previous,
    ...source.getTokensBetween(previous, statement, { includeComments: true }),
    statement,
  ];

  return boundaries.slice(1).flatMap((right, index) => {
    const left = boundaries[index];

    return right.loc.start.line - left.loc.end.line > 1
      ? [[left.range[1], right.range[0]]]
      : [];
  });
}

function fixPadding(fixer, source, { needsBlank, previous, statement, gaps }) {
  if (needsBlank) {
    const newline = source.text.includes('\r\n') ? '\r\n' : '\n';

    return fixer.insertTextAfter(
      previous,
      previous.loc.end.line === statement.loc.start.line
        ? newline.repeat(2)
        : newline,
    );
  }

  return gaps.map((range) =>
    fixer.replaceTextRange(
      range,
      source.text.slice(...range).replace(/(\r?\n)(?:[\t ]*\r?\n)+/g, '$1'),
    ),
  );
}

export default {
  meta: {
    type: 'layout',
    fixable: 'whitespace',
    schema: [],
    messages: {
      expected: 'Expected a blank line before this variable declaration.',
      unexpected: 'Unexpected blank line between short variable declarations.',
    },
  },
  create(context) {
    const source = context.sourceCode;

    return {
      VariableDeclaration(node) {
        const statement =
          node.parent.type === 'ExportNamedDeclaration' ? node.parent : node;
        const siblings = statement.parent.body ?? statement.parent.consequent;

        if (!Array.isArray(siblings)) {
          return;
        }

        const previous = siblings[siblings.indexOf(statement) - 1];

        if (!previous || unwrap(previous).type !== 'VariableDeclaration') {
          return;
        }

        const needsBlank = needsSeparation(previous, node);
        const gaps = paddingGaps(source, previous, statement);
        const hasBlank = gaps.length > 0;

        if (needsBlank === hasBlank) {
          return;
        }

        context.report({
          node: statement,
          messageId: needsBlank ? 'expected' : 'unexpected',
          fix(fixer) {
            return fixPadding(fixer, source, {
              needsBlank,
              previous,
              statement,
              gaps,
            });
          },
        });
      },
    };
  },
};
