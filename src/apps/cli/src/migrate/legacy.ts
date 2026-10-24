// The names donn had before the rename (spec 22 §1), for `donn migrate` alone. This is the only
// file in src/ that holds them; nothing else reads an old name.

export const LEGACY = {
  /** The product's old name, as messages show it. */
  name: "zzpersona",
  /** The home folder under $HOME, and a project's folder. */
  home: ".zzpersona",
  apiVersion: "zzpersona/v0",
  launchdLabel: "zzpersona.daemon",
  systemdUnit: "zzpersona-daemon.service",
  keychainService: "zzpersona-registry",
  marketplace: "zzpersona",
  plugin: "zzpersona@zzpersona",
  /** The AGENTS.md block: `<!-- zzpersona:begin … -->` … `<!-- zzpersona:end -->`. */
  marker: "zzpersona",
  managedFolder: "zzpersona",
  managedDropIn: "managed-settings.d/50-zzpersona.json",
  envPrefixes: ["ZZPERSONA_", "ZZP_"],
} as const;
