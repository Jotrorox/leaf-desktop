// @ts-check
import { useBreadcrumbs } from "../app/breadcrumbs.js";
import { Link, location } from "../lib/router/index.js";
import styles from "./Stub.module.css";

export default function NotFound() {
  useBreadcrumbs(() => [{ label: "Not found" }]);
  return (
    <>
      <h1 class={styles.title}>Page not found</h1>
      <p class={styles.lead}>
        Nothing lives at <code>{location().pathname}</code>. <Link href="/">Go to Home</Link>
      </p>
    </>
  );
}
