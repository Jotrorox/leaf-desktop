// @ts-check
import Button from "./Button.jsx";
import styles from "./ConfirmDialog.module.css";
import Dialog from "./Dialog.jsx";

/**
 * A yes/no question in a modal dialog, for destructive actions. Focus
 * starts on Cancel, so Enter alone never destroys anything.
 *
 * @param {{
 *   open: boolean,
 *   onOpenChange: (open: boolean) => void,
 *   title: string,
 *   description: string,
 *   confirmLabel: string,
 *   onConfirm: () => void,
 * }} props
 */
export default function ConfirmDialog(props) {
  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={props.title}
      description={props.description}
    >
      <div class={styles.actions}>
        <Button autofocus onClick={() => props.onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          variant="danger"
          onClick={() => {
            // Confirm first: closing may clear the state onConfirm reads.
            props.onConfirm();
            props.onOpenChange(false);
          }}
        >
          {props.confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}
