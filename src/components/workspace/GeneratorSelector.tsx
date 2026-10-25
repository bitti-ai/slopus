import { ComboBox, type ComboBoxProps } from "../ui/ComboBox";

/** Shared generator control for the Video, Image and Music toolbars. */
export function GeneratorSelector({ className = "", status, ...props }: ComboBoxProps<string> & {
  status?: { state: string; label: string; detail: string };
}) {
  return <span className={`generator-runtime ${className}${status ? ` generator-runtime--${status.state}` : ""}`}>
    <span className="generator-runtime__label" aria-hidden="true">Generator:</span>
    {status && <i role="img" aria-label={status.label} data-tooltip={status.detail} />}
    <ComboBox {...props} className="generator-template" />
  </span>;
}
