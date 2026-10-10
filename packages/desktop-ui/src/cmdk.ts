// The cmdk primitive behind `desktop-ui/command`, for a bundle that composes a
// part of it itself (the branch picker's `Command.Input asChild`, stage 9).
// It must be the window's one cmdk instance: a copy bundled into the caller
// would not see the store `Command` provides.
export { Command as CommandPrimitive } from 'cmdk';
