export function validateShrinkwrapProvenance(lock) {
	for (const [name, entry] of Object.entries(lock?.packages ?? {})) {
		if (!name || entry?.link === true) continue;
		let approvedRegistry = false;
		try { approvedRegistry = new URL(entry?.resolved).origin === "https://registry.npmjs.org"; }
		catch {}
		const validIntegrity = String(entry?.integrity ?? "").split(/\s+/u).some((candidate) => {
			if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(candidate)) return false;
			try { return Buffer.from(candidate.slice("sha512-".length), "base64").length === 64; }
			catch { return false; }
		});
		if (!approvedRegistry || !validIntegrity) {
			throw new Error(`npm shrinkwrap external entry lacks approved registry provenance and SHA-512 integrity: ${name}`);
		}
	}
}
