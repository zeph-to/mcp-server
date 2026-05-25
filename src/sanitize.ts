/**
 * Defensive cleanup for tool arguments.
 *
 * An agent occasionally emits a malformed tool call where a parameter's
 * closing tag is wrong, so the serialized markup of the *following*
 * parameters bleeds into an earlier string argument.
 *
 * Observed in the wild — a zeph_ask `body` arrived as:
 *
 *   "...Commit now or test first?</body>
 *    <parameter name=\"actions\">[{\"id\":\"commit\",...}]"
 *
 * The actions JSON leaked into `body`, and `actions` itself arrived
 * undefined — so the push showed the raw markup and no buttons.
 *
 * sanitizeText strips the leaked markup; recoverActions pulls the
 * swallowed actions array back out so the call still works.
 */

export interface RecoveredAction {
  id: string;
  label: string;
  style?: 'primary' | 'secondary' | 'danger';
}

// Markers that should never appear in a real notification body — their
// presence means tool-call markup has leaked in. Cut at the earliest one.
const LEAK_MARKERS = ['</body>', '</parameter>', '<parameter name=', '<parameter '];

const findLeakStart = (text: string): number => {
  let earliest = -1;
  for (const marker of LEAK_MARKERS) {
    const idx = text.indexOf(marker);
    if (idx !== -1 && (earliest === -1 || idx < earliest)) earliest = idx;
  }
  return earliest;
};

/**
 * Strip leaked tool-call markup from a free-text argument. Returns the
 * text unchanged when no leak is detected.
 */
export const sanitizeText = (text: string | undefined): string | undefined => {
  if (!text) return text;
  const cut = findLeakStart(text);
  return cut === -1 ? text : text.slice(0, cut).trimEnd();
};

const isActionArray = (value: unknown): value is RecoveredAction[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every(
    (a) => a && typeof (a as RecoveredAction).id === 'string' && typeof (a as RecoveredAction).label === 'string',
  );

/**
 * Recover an `actions` array that leaked into the body of a malformed
 * zeph_ask call. Returns undefined when nothing parseable is found.
 */
export const recoverActions = (text: string | undefined): RecoveredAction[] | undefined => {
  if (!text) return undefined;
  const marker = text.search(/<(?:antml:)?parameter name="actions">/);
  if (marker === -1) return undefined;

  const after = text.slice(marker);
  const start = after.indexOf('[');
  const end = after.lastIndexOf(']');
  if (start === -1 || end <= start) return undefined;

  try {
    const parsed: unknown = JSON.parse(after.slice(start, end + 1));
    return isActionArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};
