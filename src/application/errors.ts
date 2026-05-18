import type { NextAction } from "../domain/types";

export class CharterToolError extends Error {
  readonly nextActions: NextAction[];
  readonly code?: string;

  constructor(message: string, opts: { nextActions: NextAction[]; code?: string }) {
    super(message);
    this.name = "CharterToolError";
    this.nextActions = opts.nextActions;
    this.code = opts.code;
  }
}
