# Doric

## Context

The currente implementation is a simple coding agent. BUT we are going to move from this simple coding agent to a hightly sophisticated multi-agent software development lifecycle agent.

The idea is to accept one prompt from the user and enforce a strict workflow to develop or debug a feature.

I'm proposing a shift for the project, to depart from a small simple coding tool to a strict workflow with a complex multi-step specialized-agents workflow.

The motivation is that we already have multiple really good "simple" coding agents with good enought harnesses but the landscape fails to align with my philosofy or the tools that exist are tied to an specific model or harness like Claude and some workflows they just made available.

We are going to solve this issue with Doric leveraging all the tools and packages that we already have plus some new ones.

## Architecture

We are departing from the curent "chat" base to a more broad concept. The core idea is to spawn a `daemon` that will manage `worker`s, this workers will handle a `prompt` sent to them and is responsible to manage the agents and the tools (no permissions handle yet). The worker will be sandboxed inside a Docker image. Every time a new worker will be spawned, the daemon runs a docker image, in the image we will have the `worker` binary beeing executed with the source prompt and clone the target prompt, it should recieve all the necessary data to work like .env values and config files, it will comunicate with the `daemon` via gRPC, it will stream the events to the `daemon` and the `cli` can observe the internal state of the `daemon` and interact with it.

### daemon

Is a new package, it is responsible to manage and spawn a `worker` when requested.

It should be able to talk to the `cli` and the `worker`. Its responsible to know the status of the worker and which worker is running, but it's not responsible to manage the internal state of the worker like manage the transcript or tool call loop, this kind of resposability is owned by the `worker`, the `daemon` should be able to bridge the `cli` with the `worker` and what I mean by this? The `cli` may require internal state from the `worker`, this way I want to be able to have methods to sync/send the state of the `worker` to the `cli` without the `cli` talking directly to a `worker`, the data should be router throught the `daemon`.

The goal is to work with docker to sandbox each session and agent, but initially we can work without docker, we can configure a folder where we will use as a `root`, the `daemon` spawn the `worker` binary, and the `worker` perform the worker in the root OS as normal, this way we can speedup the development.

### worker

- Worker is a worker, it will be a binary that should be spawned and comunicate with the CLI via gRPC.
- It should have a initial prompt and a repo.
- The worker is responsible to manage tools, agents and it's internal state/loop.
- The worker is responsible to clone the repo in the correct folder and start the agent with the folder as a CWD or target project.
- The worker comunicates with the daemon through gRPC.

#### agents

- The goal is to achieve something like described in: C:\Users\jvito\Documents\git\spectacular\doric\.agents\skills\doric\IDEA.md, with multi-step agents. BUT, we are going to start with just the first step agent, the prompt one, until we stabilize the architecture.
- The agents should be defined in a `agents` folder under the `worker` package.
- Each agent is it's own module/folder.

#### tools

- All the existing tools should be moved to a `tools` folder under the `worker` package.

### daemon

- This is a binary that will be used to manage `worker`s.
- workers and the daemon will comunicate over gRPC, if Quick protocol is available, it will be awesome.
- Daemon only manages the state of the liveness of the `worker` and allows the "routing" of events (the communication) from the `cli` to the `worker` and vice-versa

### cli

We will initially ditch the TUI. We are going to a raw CLI experience. Maybe implement some hybrid architecture. But initially, I want the following:

- I want to be able to dispatch a job for a worker, something like: `doric feature --prompt="<prompt>" --repo="<remote_to_clone>"` or `doric debug --prompt="<prompt>" --repo="<remote_to_clone>"`
- I want to be able to list all workers and their status, something like: `doric list`. It returns a static list of the live agents and their status.
- I want to be able to stream all events from an agent using something like `doric worker <id>`, the ID would be available in the `list` command. When listenning to the agent, it will stream the events in the current terminal in a readable way.
- We should figure out how to interact with the `worker` for steps that require human in the loop. Like the first one.
