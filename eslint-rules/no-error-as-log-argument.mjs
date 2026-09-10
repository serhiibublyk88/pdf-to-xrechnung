function isLoggerReference(node) {
  if (node.type === 'Identifier') {
    return /logger$/i.test(node.name);
  }
  return (
    node.type === 'MemberExpression' &&
    !node.computed &&
    node.property.type === 'Identifier' &&
    /logger$/i.test(node.property.name)
  );
}

function isStringSyntax(node) {
  return (
    (node.type === 'Literal' && typeof node.value === 'string') ||
    node.type === 'TemplateLiteral'
  );
}

function lastNameSegment(name) {
  const segments = name.split(/(?=[A-Z])/);
  return segments[segments.length - 1];
}

function isErrorLikeReference(node) {
  if (node.type === 'Identifier') {
    return /^err(or)?$/i.test(lastNameSegment(node.name));
  }
  if (node.type === 'MemberExpression' && !node.computed) {
    return (
      (node.property.type === 'Identifier' &&
        /^err(or)?$/i.test(lastNameSegment(node.property.name))) ||
      isErrorLikeReference(node.object)
    );
  }
  if (node.type === 'CallExpression') {
    return (
      isErrorLikeReference(node.callee) ||
      node.arguments.some(isErrorLikeReference)
    );
  }
  return false;
}

function interpolatesError(node) {
  return (
    node.type === 'TemplateLiteral' &&
    node.expressions.some(isErrorLikeReference)
  );
}

const noErrorAsLogArgument = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require structured fields before the message in error, warning and fatal logs, and keep errors out of the message itself.',
    },
    schema: [],
    messages: {
      objectFirst:
        'Multi-argument error, warning and fatal logs must pass structured fields first and a literal message second.',
      noErrorInterpolation:
        'Interpolating an error into a template literal drops it from the log; pass it as a structured field first instead.',
    },
  },

  create(context) {
    return {
      CallExpression(node) {
        if (
          node.arguments.length < 1 ||
          node.callee.type !== 'MemberExpression' ||
          node.callee.computed ||
          node.callee.property.type !== 'Identifier' ||
          !['error', 'warn', 'fatal'].includes(node.callee.property.name) ||
          !isLoggerReference(node.callee.object)
        ) {
          return;
        }

        if (node.arguments.length === 1) {
          const [argument] = node.arguments;
          if (interpolatesError(argument)) {
            context.report({ node, messageId: 'noErrorInterpolation' });
          }
          return;
        }

        const [fields, message] = node.arguments;
        if (isStringSyntax(fields) || !isStringSyntax(message)) {
          context.report({ node, messageId: 'objectFirst' });
          return;
        }
        if (interpolatesError(message)) {
          context.report({ node, messageId: 'noErrorInterpolation' });
        }
      },
    };
  },
};

export default {
  rules: { 'no-error-as-log-argument': noErrorAsLogArgument },
};
