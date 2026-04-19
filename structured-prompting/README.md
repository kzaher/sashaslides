I want to create a typecsript library which can be used to working with claude code or other llm clis.

It enables a more precise and high level specification for the desired llm task.

Instead of describing high level requirement what steps llm need to do in a natural language, it's described partially in code.

This should be implemented as a typescript library in this directory.

All typescript objects should be immutable.

This should be approximate usage.

When any of the functions fail the failure information is left in the conversation trace.

```
interface CommonSendArguments {
  base64_attachments?: string[]
  timeout?: int
}

type Func<A1, A2, R> = (arg1: A1, arg2: A2) => R;
type Result<T> = T | { error: string }

interface ClaudeSesion extends Session {
  function prependToNextPrompt(prefix: string) -> Session
  function appendToNextPrompt(prefix: string) -> Session
  function pipe<T>(Func<Session, SessionWithResult<T>> pipe) -> SessionWithResult<T>
  function send<T = string>({prompt: str, ...CommonSendArguments}) -> SessionWithResult<T>
  function parallelFork<T, R>(arguments: T[], Func<Session, T, R> apply) -> SessionWithResult<R[]>
  function try<R=string>(Func<Session, R> code, Func<Session, R> fallback) -> SessionWithResult<R>
  // implemented as extension on top of try.
  // If the exeception is of type InterruptException then don't retry more, go to fallback immediatelly.
  // The method will make sure to add at the end of every prompt information that if the model wants to stop it should emit "InterruptException" string.
  // It should also override the parsing code to make that check.
  // For any other error the error is prepended to the next prompt call.
  function tryMultipleTimes<R=string>(max: int, Func<Session, R> code, Func<Session, object, R> fallback = (_, e) => { throw e }) -> SessionWithResult<R>
  // forks the session
  function fork()
  // Starts a new session with the same model.
  function newSession()
}
interface SessionWithResult<T> extends Session {
  function sendFormatted<R>({format: str, ...CommonSendArguments}) -> SessionWithResult<R>
  function executeShell(Func<R, string> buildCommand) -> SessionWithResult<string>
  function combineWith<R, JointResult = T>(Func<SessionWithResult<T>, R> execution, Func<T, R, JointResult> combine = (r, _) => r) -> SessionWithResult<JointResult>
  // pure extension
  function assert(Funct<T, Void> check) -> SessionWithResult<T>
  // Sets the result to the error object { error: "error argument" }
  function materializeError(error: str) -> SessionWithResult<Result<T>>
}
inteface ForkedSession extends Sesion {
  fuction compact() -> CompactedSession
}
interface CompactedSesson extends Session {
  function switchModel(Func<any, any> model) -> Session
}

function safelyJsonStrigify(object value) -> string {
  try {
    return JSON.stringify(value);
  } catch (e) {
    ...
  }
}
```
Example usage
```
function main(session: Session, tasks: { workspace_dir: string, bug: str }[]) -> SessionWithResult<Result<{ serverRunningPort: int, originalMeasurement: string, newMeasurement: string }>[]> {
  tryWithModel = (Session s, t) => (
    s
      .sendFormatted<{ measuredValue: string }>($"This is the task `{task}`. First find a method to measure the original property, write an execute code to measure the property which will prove change is effective and only measure it.")
      .combineWith((s, r) =>
          s.prompt("Now perform the changes to fix the bug.")
            .prompt<{ measuredValue: string }>("Now use the same method to measure the property value"),
          (r1, r2) => { 
            if (r1.measuredValue != r2.measuredValue) {
              throw Error($'Measured values are the same {r1.measuredValue}');
            }
          }
      )
  );
  session.fork().compact().parallelFork(tasks, 
    (s, t) => 
      s
        .switchModel(Claude.)
        .combineWith(_ => _.executeShell(...somehow checkout working directory into git workspace...))
        .tryMultipleTimes(3, tryWithModel, (s, e) =>
          s.fork().compact()
          .switchModel(Claude.switchOpus)
          .prependToNextPrompt($'There was an error ${safelyJsonStringify(e)}.')
          .tryMultipleTimes(3, tryWithModel)
        )
        // Otherwise others would be cancelled.
        .materializeError()
  )
}
```

The only exception to immutability is the computaion graph that the previous interface methods on conversation are changing.

The exception thrown should return current session so the model can debug what went wrong with the execution.

The computation graph is assigned to every session. Every operation creates a logical node of the code executed so far. So for example, parallelFork will create N parallel nodes. Every operation usually creates a sequential node after the previous one. If the node was a model call and when selected the right side of screen should contain input arguments, string response and structured parsed output. If the node contains validation, then it should contain validation error.

And executes it. While its executing it it renders a link to the server where it's possible to monitor progress of execution nodes, and supports debugging as explained above. Even after the operation completes it should continue presenting state.

When the new execution of the engine starts then the UI shows the new UI.

The structured execution should now be a ts file used for every execution which defines it. When the claude cli stops execution then this execution engine should also be stopped. Maybe using claude code hooks for this.

There should be an engine and an engine function which takes
```
interface ClaudeEngine {
  async function execute<R=string>(Session session, Func<Session, SessionWithResult<R>> calculation) -> R
}
```

Claude code usage
```
...
return sharedClaudeEngine.execute(new Session({sessionId: "xxxx-xxx-xxxx-xxx"}), session => mainWithArguments({session, tasks: [....]}))
...
```

There should be a skill called structured prompting which wraps this library and explains server management and building the configuration.

Ever project should have structured prompts directory which uses structured-prompting directory so the structured prompts are reusable in the future during iterations. Structured prompts can be edited by claude code but also by the user.