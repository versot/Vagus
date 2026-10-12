

export type ProjectArchiveNotice = ({ kind: "archived"; sessionIds: string[]; count: number; scope: "project" | "single" } | { kind: "undoing" } | { kind: "undone" }) & { closing?: boolean };
