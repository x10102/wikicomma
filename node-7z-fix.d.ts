
// thanks
// very cool

export interface Data {
    file: string;
    status: string;
    attributes?: string | undefined;
    size?: number | undefined;
    sizeCompressed?: number | undefined;
    hash?: string | undefined;
}

export interface Progress {
    percent: number;
    fileCount: number;
    file?: string | undefined;
}

// NOTE - The names are not wrong, some are spelt wrong in the source
export interface CommandLineSwitches {
    /** Extract file as alternate stream, if there is ':' character in name (-snc) */
    alternateStreamExtract?: boolean | undefined;
    /** Replace ':' character to '_' character in paths of alternate streams (-snr) */
    alternateStreamReplace?: boolean | undefined;
    /** Delete files after compression (-sdel) */
    deleteFilesAfter?: boolean | undefined;
    /** Usefully qualified file paths (-spf) */
    fullyQualifiedPaths?: boolean | undefined;
    /** Store hard links as links (WIM and TAR formats only) (-snh) */
    hardlinks?: boolean | undefined;
    /** Set Large Pages mode (-spl) */
    largePages?: boolean | undefined;
    /** Set archive timestamp from the most recently modified file (-stl) */
    latestTimeStamp?: boolean | undefined;
    /** Stop archive creating, if 7-Zip can't open some input file.(-sse) */
    noArchiveOnFail?: boolean | undefined;
    /** Eliminate duplication of root folder for extract command (-spe) */
    noRootDuplication?: boolean | undefined;
    /** Disable wildcard matching for file names (-spd) */
    noWildcards?: boolean | undefined;
    /** Store NT security (-sni) */
    ntSecurity?: boolean | undefined;
    /** Sort files by type while adding to solid 7z archive (-mqs) */
    sortByType?: boolean | undefined;
    /** Compress files open for writing (-ssw) */
    openFiles?: boolean | undefined;
    /** Recurse subdirectories. For -r0 usage use $raw (-r) */
    recursive?: boolean | undefined;
    /** Store symbolic links as links (WIM and TAR formats only) (-snl) */
    symlinks?: boolean | undefined;
    /** Show technical information (-slt) */
    techInfo?: boolean | undefined;
    /** Show execution time statistics (-bt) */
    timeStats?: boolean | undefined;
    /** Write data to stdout (-so) */
    toStdout?: boolean | undefined;
    /** Assume Yes on all queries (-y) */
    yes?: boolean | undefined;
    /** Store NTFS alternate Streams (-sns) */
    alternateStreamStore?: boolean | undefined;
    /** Set Sensitive Case mode (-ssc) */
    caseSensitive?: boolean | undefined;
    /** Set Archive name mode (-sa) */
    archiveNameMode?: string | undefined;
    /** Type of archive (-t) */
    archiveType?: string | undefined;
    /** Set CPU thread affinity mask (hexadecimal number). (-stm) */
    cpuAffinity?: string | undefined;
    /** Exclude archive type (-stx) */
    excludeArchiveType?: string | undefined;
    /** Read data from StdIn (-si) */
    fromStdin?: string | undefined;
    /** Set hash function (-scrc) */
    hashMethod?: string | undefined;
    /** Set charset for list files (-scs) */
    listFileCharset?: string | undefined;
    /** Set charset for console input/output */
    charset?: string | undefined;
    /** Set output log level (-bb) */
    logLevel?: string | undefined;
    /** Set Output directory (-o) */
    outputDir?: string | undefined;
    /** Set Password (-p) */
    password?: string | undefined;
    /** Create SFX archive (-sfx) */
    sfx?: string | undefined;
    /** Update options (-u) */
    updateOptions?: string | undefined;
    /** Set Working directory (-w) */
    workingDir?: string | undefined;
    /** Creates multi-block xz archives by default. Block size can be specified with [Size]{m|g} */
    multiBlockSize?: string | undefined;
    /** Exclude archive filenames (-ax) */
    excludeArchive?: string[] | undefined;
    /** Exclude filenames (-x) */
    exlude?: string[] | undefined;
    /** Include filenames (-i) */
    include?: string[] | undefined;
    /** Include archive filenames (-ai) */
    includeArchive?: string[] | undefined;
    /** Set Compression Method (-m) */
    method?: string[] | undefined;
    /** Set output stream for output/error/progress (-bs) */
    outputStreams?: string[] | undefined;
    /** Create Volumes (v) */
    volumes?: string[] | undefined;
}

export interface Node7zOptions {
    /**
     * Progress percentage gets fired. Shortcut for { outputStreams: ['b1'] }
     * Use if you want access to the progress event. Has an impact on performances.
     */
    $progress?: boolean | undefined;
    /** Create the stream but do not spawn child process */
    $defer?: boolean | undefined;
    /** Attach an external child process to be parsed */
    $childProcess?: ChildProcess | undefined;
    /** Path to an other 7-Zip binary. Default: 7z */
    $bin?: string | undefined;
    /** Some commands accepts more specific targets. See https://github.com/quentinrossetti/node-7z#extract for an example. */
    $cherryPick?: string[] | undefined;
    /** Pass raw arguments to the child_process.spawn() command */
    $raw?: string[] | undefined;
    /** Pass options to the child_process.spawn() command */
    $spawnOptions?: object | undefined;
}

export type SevenZipOptions = Node7zOptions & CommandLineSwitches;
