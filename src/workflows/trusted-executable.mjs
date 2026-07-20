import fs from "node:fs";
import path from "node:path";

export function windowsTrustedExecutableRoots(report = process.report?.getReport?.()) {
	const sharedObjects = Array.isArray(report?.sharedObjects) ? report.sharedObjects : [];
	for (const object of sharedObjects) {
		if (typeof object !== "string") continue;
		const system32 = path.win32.dirname(object);
		const systemRoot = path.win32.dirname(system32);
		if (!/^(?:kernel32|ntdll)\.dll$/iu.test(path.win32.basename(object)) ||
			path.win32.basename(system32).toLowerCase() !== "system32" ||
			path.win32.basename(systemRoot).toLowerCase() !== "windows") continue;
		const drive = path.win32.parse(systemRoot).root;
		if (!/^[a-z]:\\$/iu.test(drive)) continue;
		// The Windows loader's resolved KnownDLL path is process state rather than
		// caller-controlled environment. Derive every admitted tool root from that
		// drive and fail closed if the runtime report cannot establish it.
		return [
			path.win32.join(systemRoot, "System32"),
			path.win32.join(drive, "Program Files", "Git"),
			path.win32.join(drive, "Program Files (x86)", "Git"),
		];
	}
	throw new Error("release verification cannot establish trusted Windows executable roots from the loaded operating system");
}

export function userControlledPathRoots(root) {
	const roots = [];
	const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
	const groups = typeof process.getgroups === "function" ? new Set(process.getgroups()) : new Set();
	if (typeof process.getgid === "function") groups.add(process.getgid());
	for (let current = path.resolve(root), first = true; ;) {
		const parent = path.dirname(current);
		if (parent === current) break;
		let controlled = first;
		try {
			const stat = fs.lstatSync(current);
			controlled ||= uid !== undefined && stat.uid === uid;
			controlled ||= (stat.mode & 0o002) !== 0;
			controlled ||= groups.has(stat.gid) && (stat.mode & 0o020) !== 0;
		} catch { controlled = first; }
		if (!controlled) break;
		roots.push(current);
		current = parent;
		first = false;
	}
	return roots;
}

export function trustedExecutableOnPath(command, environment = process.env, excludedRoot, options = {}) {
	const platform = options.platform ?? process.platform;
	const windowsRoots = platform === "win32" ? (options.windowsRoots ?? windowsTrustedExecutableRoots()) : [];
	const excludedRoots = (Array.isArray(excludedRoot) ? excludedRoot : [excludedRoot]).filter(Boolean).map((root) => path.resolve(root));
	const allowedRoots = (options.allowedRoots ?? []).filter(Boolean).map((root) => {
		try { return fs.realpathSync(path.resolve(root)); }
		catch { return undefined; }
	}).filter(Boolean);
	const isWithin = (root, candidate) => {
		const relative = path.relative(root, candidate);
		return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
	};
	const trustedModeAndOwner = (file) => {
		if (platform === "win32") {
			const root = allowedRoots.find((candidate) => isWithin(candidate, file));
			// Portable Node exposes no native Windows security-descriptor API, and
			// invoking a candidate from System32 to authenticate its own ACL is
			// circular. Real Windows channel installs therefore fail closed unless
			// an embedder supplies an independently authenticated native verifier.
			return Boolean(root) && typeof options.windowsAclCheck === "function" &&
				options.windowsAclCheck(file, root, windowsRoots) === true;
		}
		const stat = fs.statSync(file);
		const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
		const trustedOwner = uid === undefined || stat.uid === 0 || (!options.requireRootOwnership && stat.uid === uid);
		return (stat.mode & 0o022) === 0 && trustedOwner;
	};
	const pathName = Object.keys(environment).find((name) => name.toLowerCase() === "path");
	const search = environment[pathName] || "/usr/local/bin:/usr/bin:/bin";
	const extensions = platform === "win32" && path.extname(command) === ""
		? String(environment.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
		: [""];
	const delimiter = platform === "win32" ? ";" : path.delimiter;
	for (const directory of search.split(delimiter).filter(Boolean)) {
		for (const extension of extensions) {
			const candidate = path.resolve(directory, `${command}${extension}`);
			let physical;
			try { physical = fs.realpathSync(candidate); } catch { continue; }
			if (excludedRoots.some((root) => isWithin(root, physical))) continue;
			try {
				const stat = fs.statSync(physical);
				if (!stat.isFile() || !trustedModeAndOwner(physical)) continue;
				let ancestor = path.dirname(physical);
				let trustedAncestors = true;
				if (platform !== "win32") {
					for (;;) {
						if (!trustedModeAndOwner(ancestor)) { trustedAncestors = false; break; }
						const parent = path.dirname(ancestor);
						if (parent === ancestor) break;
						ancestor = parent;
					}
				}
				if (!trustedAncestors) continue;
				fs.accessSync(physical, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
				return physical;
			} catch {}
			}
	}
	throw new Error(`release verification requires a trusted external ${command} executable`);
}
