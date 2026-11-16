// Minimal types for the Node built-ins used by *.test.js files, so they
// type-check without @types/node (no new dependencies). Extend as tests need more.

declare module "node:test" {
  type Fn = () => unknown;
  export function test(name: string, fn: Fn): Promise<void>;
  export function describe(name: string, fn: Fn): Promise<void>;
  export function it(name: string, fn: Fn): Promise<void>;
  export function before(fn: Fn): void;
  export function after(fn: Fn): void;
  export function beforeEach(fn: Fn): void;
  export function afterEach(fn: Fn): void;
}

declare module "node:assert/strict" {
  type Expected = RegExp | Function | object | ((err: unknown) => boolean);
  interface Assert {
    (value: unknown, message?: string): asserts value;
    ok(value: unknown, message?: string): asserts value;
    equal<T>(actual: unknown, expected: T, message?: string): asserts actual is T;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual<T>(actual: unknown, expected: T, message?: string): asserts actual is T;
    notDeepEqual(actual: unknown, expected: unknown, message?: string): void;
    match(value: string, regexp: RegExp, message?: string): void;
    throws(fn: () => unknown, expected?: Expected, message?: string): void;
    rejects(
      promise: Promise<unknown> | (() => Promise<unknown>),
      expected?: Expected,
      message?: string,
    ): Promise<void>;
    fail(message?: string): never;
  }
  const assert: Assert;
  export default assert;
}
