import Realm from "realm";

const realmPath = process.argv[2];
if (!realmPath) {
	process.stderr.write(JSON.stringify({ error: "No realm path provided" }));
	process.exit(1);
}

const realm = await Realm.open({ path: realmPath, readOnly: true });

function serializeValue(val, propSchema, depth = 0) {
	if (val === null || val === undefined) return val;
	if (val instanceof Realm.BSON.ObjectId || val instanceof Realm.BSON.UUID) return val.toHexString();
	if (val instanceof Realm.BSON.Decimal128) return val.toString();
	if (val instanceof Date) return val.toISOString();

	if (val instanceof Realm.Results || val instanceof Realm.List || val instanceof Realm.Set) {
		return Array.from(val).map((item) => serializeValue(item, propSchema, depth));
	}

	if (val instanceof Realm.Object) {
		const targetSchema = propSchema?.objectType
			? realm.schema.find((s) => s.name === propSchema.objectType)
			: null;

		// has a primary key -> just reference it, avoids re-dumping the whole linked object
		if (targetSchema?.primaryKey) {
			return { _type: propSchema.objectType, _pk: serializeValue(val[targetSchema.primaryKey], null) };
		}

		// no primary key -> almost certainly embedded (e.g. a Filename+File pairing) -> expand fully
		if (targetSchema && depth < 3) {
			const record = {};
			for (const [key, childPropSchema] of Object.entries(targetSchema.properties)) {
				record[key] = serializeValue(val[key], childPropSchema, depth + 1);
			}
			return record;
		}

		return `[${propSchema?.objectType}]`;
	}

	if (typeof val === "object" && val !== null) return String(val);
	return val;
}
const result = {};

for (const objSchema of realm.schema) {
	if (objSchema.embedded) continue;
	const objects = realm.objects(objSchema.name);
	result[objSchema.name] = Array.from(objects).map((obj) => {
		const record = {};
		for (const [key, propSchema] of Object.entries(objSchema.properties)) {
			record[key] = serializeValue(obj[key], propSchema);
		}
		return record;
	});
}

const json = JSON.stringify(result);
realm.close();
process.stdout.write(json, () => process.exit(0));
