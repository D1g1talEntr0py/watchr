/** Default rename timeout in milliseconds */
const renameTimeout = 150;

/** Default per-stat timeout in milliseconds for live polls */
const statTimeout = 1000;

/** Default minimum interval in milliseconds between fallback snapshot scans of a watched root */
const fallbackScanInterval = 50;

/**
 * Maximum concurrent stat calls admitted process-wide. Stat throughput is bound by the libuv threadpool, not descriptors,
 * so the limit only needs to cap pathological bursts: the initial scan and live dispatch are bounded well below it.
 */
const maxConcurrentStats: number = Math.max(256, 16 * Number(process.env.UV_THREADPOOL_SIZE ?? 4));

/** Inode types */
const InodeType = {
	DIR: 1,
	FILE: 2
} as const;

/** Inode type */
type InodeType = typeof InodeType[keyof typeof InodeType];

/** Node watcher events */
const NodeWatcherEvent = {
	CHANGE: 'change',
	ERROR: 'error'
} as const;

const NodeTargetEvent = {
	CHANGE: 'change',
	RENAME: 'rename'
} as const;

type NodeTargetEvent = typeof NodeTargetEvent[keyof typeof NodeTargetEvent];

const WatcherEvent = {
	ALL: 'all',
	CLOSE: 'close',
	ERROR: 'error',
	READY: 'ready'
} as const;

const FileSystemEvent = {
	ADD: 'add',
	ADD_DIR: 'addDir',
	CHANGE: 'change',
	RENAME: 'rename',
	RENAME_DIR: 'renameDir',
	UNLINK: 'unlink',
	UNLINK_DIR: 'unlinkDir'
} as const;

type FileSystemEvent = typeof FileSystemEvent[keyof typeof FileSystemEvent];

const DirectoryEvent = {
	add: FileSystemEvent.ADD_DIR as typeof FileSystemEvent.ADD_DIR,
	rename: FileSystemEvent.RENAME_DIR as typeof FileSystemEvent.RENAME_DIR,
	unlink: FileSystemEvent.UNLINK_DIR as typeof FileSystemEvent.UNLINK_DIR
} as const;

const FileEvent = {
	add: FileSystemEvent.ADD as typeof FileSystemEvent.ADD,
	change: FileSystemEvent.CHANGE as typeof FileSystemEvent.CHANGE,
	rename: FileSystemEvent.RENAME as typeof FileSystemEvent.RENAME,
	unlink: FileSystemEvent.UNLINK as typeof FileSystemEvent.UNLINK
} as const;

export {
	InodeType,
	NodeWatcherEvent,
	NodeTargetEvent,
	WatcherEvent,
	FileSystemEvent,
	DirectoryEvent,
	FileEvent,
	maxConcurrentStats,
	renameTimeout,
	statTimeout,
	fallbackScanInterval
};
