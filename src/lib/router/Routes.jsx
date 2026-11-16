// @ts-check
import { children, createContext, createMemo, Show, useContext } from "solid-js";
import { Dynamic } from "solid-js/web";
import { location } from "./location.js";
import { matchRoutes } from "./match.js";

/** @typedef {import("./match.js").Params} Params */
/** @typedef {import("solid-js").Component<{ params: Params }>} RouteComponent */
/** @typedef {{ path: string, component: RouteComponent }} RouteProps */

const ParamsContext = createContext(/** @type {() => Params} */ (() => ({})));

/** The current route's params, as a reactive accessor. */
export function useParams() {
  return useContext(ParamsContext);
}

/**
 * Declares a route inside `<Routes>`. Renders nothing itself: `<Routes>` reads its props.
 * @param {RouteProps} props
 * @returns {import("solid-js").JSX.Element}
 */
export function Route(props) {
  return /** @type {import("solid-js").JSX.Element} */ (/** @type {unknown} */ (props));
}

/**
 * Renders the first `<Route>` whose path matches the current location, or
 * `fallback` (the 404 page) when none does. Moving between two URLs of the
 * same route (`/p/a` → `/p/b`) keeps the component and updates `params`.
 *
 * @param {{ children: import("solid-js").JSX.Element, fallback?: import("solid-js").Component }} props
 */
export function Routes(props) {
  const resolved = children(() => props.children);
  const routes = createMemo(() =>
    /** @type {RouteProps[]} */ (/** @type {unknown[]} */ (resolved.toArray())).filter(
      (route) => route && typeof route === "object" && "path" in route,
    ),
  );
  const match = createMemo(() => {
    const list = routes();
    const found = matchRoutes(
      list.map((route) => route.path),
      location().pathname,
    );
    return found && { route: list[found.index], params: found.params };
  });
  const route = createMemo(() => match()?.route);
  const params = () => match()?.params ?? {};

  return (
    <Show when={route()} keyed fallback={props.fallback && <Dynamic component={props.fallback} />}>
      {(current) => (
        <ParamsContext.Provider value={params}>
          <Dynamic component={current.component} params={params()} />
        </ParamsContext.Provider>
      )}
    </Show>
  );
}
