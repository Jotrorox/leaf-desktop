// @ts-check
import { Match, Switch } from "solid-js";
import { ApiError } from "../../api/client.js";
import { usePage } from "../../data/pages.js";
import { Link } from "../../lib/router/index.js";
import styles from "./Database.module.css";
import DatabaseView from "./DatabaseView.jsx";

/**
 * The editor's database block: the database inline, or why it can't be.
 * Inside the editor it's an island (`data-embed`, not editable text), so
 * its fields and keys aren't the document's.
 * @param {{ databaseId: string }} props
 */
export default function DatabaseEmbed(props) {
  const page = usePage(() => props.databaseId || undefined);
  const gone = () => {
    const error = page.error();
    return error instanceof ApiError && error.status === 404;
  };
  return (
    <div class={styles.embed}>
      <Switch>
        <Match when={page.data()?.kind === "database" && !page.data()?.archived_at && page.data()}>
          {(db) => <DatabaseView page={db()} inline />}
        </Match>
        <Match when={page.data()?.archived_at}>
          <p class={styles.embedMissing}>
            This database is in the trash.{" "}
            <Link href={`/p/${encodeURIComponent(props.databaseId)}`}>Open it</Link> to restore it.
          </p>
        </Match>
        <Match
          when={gone() || !props.databaseId || (page.data() && page.data()?.kind !== "database")}
        >
          <p class={styles.embedMissing}>This database was deleted.</p>
        </Match>
        <Match when={page.error()}>
          <p class={styles.embedMissing}>Couldn't load this database.</p>
        </Match>
        <Match when={true}>
          <p class={styles.embedMissing} role="status">
            Loading database…
          </p>
        </Match>
      </Switch>
    </div>
  );
}
