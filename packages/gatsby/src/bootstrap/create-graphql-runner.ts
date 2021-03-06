import stackTrace from "stack-trace"
import { Span } from "opentracing"
import { ExecutionResultDataDefault } from "graphql/execution/execute"
import { Store } from "redux"

import { GraphQLRunner } from "../query/graphql-runner"
import errorParser from "../query/error-parser"
import { emitter } from "../redux"
import { Reporter } from "../.."
import { ExecutionResult, Source } from "../../graphql"
import { IGatsbyState } from "../redux/types"

type Runner = (
  query: string | Source,
  context: Record<string, any>
) => Promise<ExecutionResult<ExecutionResultDataDefault>>

export const createGraphQLRunner = (
  store: Store<IGatsbyState>,
  reporter: Reporter,
  {
    parentSpan,
    graphqlTracing,
  }: { parentSpan: Span | undefined; graphqlTracing?: boolean } = {
    parentSpan: undefined,
    graphqlTracing: false,
  }
): Runner => {
  // TODO: Move tracking of changed state inside GraphQLRunner itself. https://github.com/gatsbyjs/gatsby/issues/20941
  let runner = new GraphQLRunner(store, { graphqlTracing })

  const eventTypes: string[] = [
    `DELETE_CACHE`,
    `CREATE_NODE`,
    `DELETE_NODE`,
    `DELETE_NODES`,
    `SET_SCHEMA_COMPOSER`,
    `SET_SCHEMA`,
    `ADD_FIELD_TO_NODE`,
    `ADD_CHILD_NODE_TO_PARENT_NODE`,
  ]

  eventTypes.forEach(type => {
    emitter.on(type, () => {
      runner = new GraphQLRunner(store)
    })
  })

  return (query, context): ReturnType<Runner> =>
    runner
      .query(query, context, {
        queryName: `gatsby-node query`,
        parentSpan,
      })
      .then(result => {
        if (result.errors) {
          const structuredErrors = result.errors
            .map(e => {
              // Find the file where graphql was called.
              const file = stackTrace
                .parse(e)
                .find(file => /createPages/.test(file.getFunctionName()))

              if (file) {
                const structuredError = errorParser({
                  message: e.message,
                  location: {
                    start: {
                      line: file.getLineNumber(),
                      column: file.getColumnNumber(),
                    },
                  },
                  filePath: file.getFileName(),
                })
                structuredError.context = {
                  ...structuredError.context,
                  fromGraphQLFunction: true,
                }
                return structuredError
              }

              return null
            })
            .filter(Boolean)

          if (structuredErrors.length) {
            // panic on build exits the process
            reporter.panicOnBuild(structuredErrors)
          }
        }

        return result
      })
}
