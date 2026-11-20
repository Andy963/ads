/** A control-plane stop, never a code defect or a developer rework request. */
export class ReviewerIncompleteError extends Error {
  readonly code = "REVIEW_INCOMPLETE";
  constructor(message: string) {
    super(message);
    this.name = "ReviewerIncompleteError";
  }
}
