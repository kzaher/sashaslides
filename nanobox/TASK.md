There is /workspaces/sashaslides/nanobox. It's container to wasm implementation at the moment.

The problem is that it's running slow. Your task is to optimize it. There are projects like https://webvm.io/, but we can't use it because it's 386.

Currently all 3 bots run successfully in browser.

Your task is to create a more efficient VM to run wasm, I think webvm uses some JIT and that makes it 10x faster. You can perform the same optimizations and principles but for x86_64. If you have to build the entire VM JIT, then do it. We need to make it at least 10x faster than what the current version is.

The current version is extremely valuable though. It provides correctness and proper E2E test.

You task will be to make sure your optimizations produce byte to byte identical in memory result. Build yourself a debugging and testing harness which allows you to debug relative to the this currenly working implementation.

The 3 of you will be working in parallel, each should put artifacts into your own directory so you don't collide.
* Antigravity in /workspaces/sashaslides/nanobox/agy
* Claude in /workspaces/sashaslides/nanobox
* Codex in /workspaces/sashaslides/nanobox/codex

When you get stuck feel free to take inspiration from your neighbour, but do whatever it takes to optimize and have identical memory result. (If the program code changes, that is ok, but the data segments shouldn't change)

This is meant to be a long epic epoch and not a quick task. If it takes you a day, that's fine, don't give up. Use neigbors for inspiration and inspire them. Who every reaches end wins. If multiple ones reach it, that's also ok.

Only Bochs engine worked correctly. Make sure to make this your starting point and where to take the memory model from.

The final E2E test must produce identical memory result as the Bochs engine currently produces when it reaches the sign in screen.

The final artifact (has to be in your directory):
* There needs to be index page leading to 3 subpages one for each agent in browser (claude, codex, agy).
* Each subpage has to show page which boots two engines in parallel.
* The top of is the original one.
* The bottom one is the optimized one. 
* Below each is a timer which counts time until sign in screen.
* This is the time I want reported.