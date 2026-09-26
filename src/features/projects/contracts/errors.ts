export const projectErrors = {
  ENTITLEMENT_REQUIRED: { status: 403, message: "Creating projects isn't enabled for this account." },
  OWNED_PROJECT_LIMIT: { status: 422, message: "You've reached your active project limit. Archive a project or ask for a higher limit." },
  OWNER_CANNOT_LEAVE: { status: 409, message: "The project owner can't leave. Archive the project instead." },
  ALREADY_MEMBER: { status: 409, message: "You already have access to this project." },
  COLLABORATOR_LIMIT: { status: 422, message: "This project is full (10 collaborators including the owner)." },
  INVITATION_LIMIT: { status: 409, message: "This project already has the maximum number of pending invitations." },
  NOT_FOUND: { status: 404, message: "This project or invitation is unavailable." },
  KEY_REUSED: { status: 409, message: "This request conflicts with an earlier request." },
  INVALID_INPUT: { status: 400, message: "Check the details and try again." },
  CONFLICT: { status: 409, message: "That change conflicts with current data. Refresh and try again." },
  FORBIDDEN: { status: 403, message: "This action isn't available for your account." },
  UNAVAILABLE: { status: 503, message: "Project access is unavailable. Try again." },
} as const;

export type ProjectErrorCode = keyof typeof projectErrors;
