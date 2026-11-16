// @ts-check
import { createSignal, For, onCleanup } from "solid-js";
import { mockControls } from "../api/mock/index.js";
import { ROADMAP_ID } from "../api/mock/seed-database.js";
import { dbKeys } from "../data/databases.js";
import { keys } from "../data/pages.js";
import { invalidate, queryClient } from "../lib/query/index.js";
import { location } from "../lib/router/index.js";
import IconButton from "../ui/IconButton.jsx";
import { IconFlask, IconRestore, IconTable } from "../ui/icons/index.jsx";
import Menu, { MenuGroup, MenuItem, MenuSeparator } from "../ui/Menu.jsx";
import { toast } from "../ui/Toast.jsx";
import styles from "./Sidebar.module.css";

const LATENCIES = [
  { ms: 0, label: "No latency" },
  { ms: 300, label: "300 ms latency" },
  { ms: 1500, label: "1.5 s latency" },
];

/** @type {{ role: import("../api/roles.js").Role, label: string }[]} */
const ROLE_OPTIONS = [
  { role: "owner", label: "Owner" },
  { role: "edit", label: "Can edit" },
  { role: "comment", label: "Can comment" },
  { role: "view", label: "Can view" },
];

const FAILURES = [
  { every: 0, label: "Writes succeed" },
  { every: 3, label: "Every 3rd write fails" },
  { every: 1, label: "Every write fails" },
];

/**
 * Dev menu for the mock backend (only in mock mode, loaded lazily): set
 * latency, make writes fail to see rollback, take the network down to see
 * offline mode, see pages as a viewer, reset the data.
 */
export default function MockMenu() {
  const [config, setConfig] = createSignal(mockControls.config);
  onCleanup(mockControls.subscribe((next) => setConfig(next)));

  return (
    <Menu
      label="Mock API"
      placement="bottom-start"
      trigger={(triggerProps) => (
        <IconButton {...triggerProps} label="Mock API" class={styles.mockButton}>
          <IconFlask />
        </IconButton>
      )}
    >
      <MenuGroup label="Latency">
        <For each={LATENCIES}>
          {(option) => (
            <MenuItem
              checked={config().latency === option.ms}
              onSelect={() => mockControls.configure({ latency: option.ms })}
            >
              {option.label}
            </MenuItem>
          )}
        </For>
      </MenuGroup>
      <MenuSeparator />
      <MenuGroup label="Failing writes">
        <For each={FAILURES}>
          {(option) => (
            <MenuItem
              checked={config().failEvery === option.every}
              onSelect={() => mockControls.configure({ failEvery: option.every })}
            >
              {option.label}
            </MenuItem>
          )}
        </For>
      </MenuGroup>
      <MenuSeparator />
      <MenuGroup label="Your role on pages">
        <For each={ROLE_OPTIONS}>
          {(option) => (
            <MenuItem
              checked={(config().role ?? "owner") === option.role}
              onSelect={() => {
                mockControls.configure({ role: option.role });
                // Pages carry the role: refetch them, and reopen the editor.
                void invalidate();
              }}
            >
              {option.label}
            </MenuItem>
          )}
        </For>
      </MenuGroup>
      <MenuSeparator />
      <MenuGroup label="Network">
        <MenuItem
          checked={!config().offline}
          onSelect={() => mockControls.configure({ offline: false })}
        >
          Online
        </MenuItem>
        <MenuItem
          checked={config().offline === true}
          onSelect={() => mockControls.configure({ offline: true })}
        >
          Offline
        </MenuItem>
      </MenuGroup>
      <MenuSeparator />
      <MenuItem
        icon={<IconTable />}
        onSelect={() => {
          // The database on screen, or the sample one.
          const match = /^\/p\/([^/]+)$/.exec(location().pathname);
          const current = match ? decodeURIComponent(match[1]) : null;
          const page = current
            ? /** @type {import("../api/types.js").Page | undefined} */ (
                queryClient.getData(keys.page(current))
              )
            : undefined;
          const id = page?.kind === "database" ? page.id : ROADMAP_ID;
          try {
            const total = mockControls.fillDatabase(id, 5000);
            void invalidate(dbKeys.rowsAll(id));
            toast({
              title: "Added 5,000 rows",
              description: `The database has ${total.toLocaleString()} rows now.`,
            });
          } catch (error) {
            toast({
              title: "Couldn't add rows",
              description: error instanceof Error ? error.message : String(error),
              tone: "danger",
            });
          }
        }}
      >
        Add 5,000 rows to this database
      </MenuItem>
      <MenuItem
        icon={<IconRestore />}
        onSelect={() => {
          mockControls.reset();
          void invalidate();
          toast({ title: "Mock data reset" });
        }}
      >
        Reset mock data
      </MenuItem>
    </Menu>
  );
}
