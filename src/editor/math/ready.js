// @ts-check
import { createSignal, onCleanup } from "solid-js";
import { loadMath, mathReady, onMathReady } from "./render.js";

/** Whether KaTeX has loaded, as a signal (asking starts the load). */
export function useMathReady() {
  const [ready, setReady] = createSignal(mathReady());
  if (!ready()) {
    onCleanup(onMathReady(() => setReady(true)));
    void loadMath();
  }
  return ready;
}
