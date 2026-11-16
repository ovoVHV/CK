//! Package-side resource contract. Schemas and limits are the same files used by the WebView.
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

const GRAPH: &str = include_str!("../../../../docs/schemas/ck-resource-graph.schema.json");
const CLAIMS: &str = include_str!("../../../../docs/schemas/ck-resource-claims.schema.json");
const LIMITS: &str = include_str!("../../../../docs/schemas/ck-resource-boundary.json");

fn boundary(value: &Value) -> Result<(), String> {
    let limits: Value = serde_json::from_str(LIMITS).expect("checked-in resource limits");
    fn walk(v: &Value, d: u64, n: &mut u64, bytes: &mut u64, l: &Value) -> Result<(), String> {
        *n += 1;
        if *n > l["maxNodes"].as_u64().unwrap() || d > l["maxDepth"].as_u64().unwrap() { return Err("resource.limit".into()); }
        match v {
            Value::String(s) => {
                if s.chars().count() as u64 > l["maxStringLength"].as_u64().unwrap() { return Err("resource.string_limit".into()); }
                *bytes += s.len() as u64;
            }
            Value::Array(a) => for x in a { walk(x, d + 1, n, bytes, l)?; },
            Value::Object(o) => for (k, x) in o {
                if l["forbiddenKeys"].as_array().unwrap().iter().any(|v| v.as_str() == Some(k)) { return Err("resource.unsafe_key".into()); }
                *bytes += k.len() as u64;
                walk(x, d + 1, n, bytes, l)?;
            },
            _ => {}
        }
        if *bytes > l["maxTextBytes"].as_u64().unwrap() { return Err("resource.byte_limit".into()); }
        Ok(())
    }
    walk(value, 0, &mut 0, &mut 0, &limits)
}
fn schema(value: &Value, claims: bool) -> Result<(), String> {
    static G: OnceLock<jsonschema::Validator> = OnceLock::new();
    static C: OnceLock<jsonschema::Validator> = OnceLock::new();
    boundary(value)?;
    let validator = if claims { &C } else { &G }.get_or_init(|| {
        // Only checked-in local $refs. jsonschema network/file fetching features are disabled.
        jsonschema::validator_for(&serde_json::from_str(if claims { CLAIMS } else { GRAPH }).unwrap()).expect("checked-in resource schema")
    });
    validator.validate(value).map_err(|e| format!("resource.schema:{}", e.instance_path))
}
pub(crate) fn validate_graph(value: &Value) -> Result<(), String> {
    schema(value, false)?;
    let resources = value["resources"].as_array().unwrap();
    let evidence = value["evidence"].as_array().unwrap();
    let map: HashMap<&str, &Value> = resources.iter().map(|r| (r["id"].as_str().unwrap(), r)).collect();
    let evidence_ids: HashSet<&str> = evidence.iter().map(|e| e["id"].as_str().unwrap()).collect();
    if map.len() != resources.len() || evidence_ids.len() != evidence.len() { return Err("resource.duplicate_id".into()); }
    let mut aliases: HashSet<&str> = map.keys().copied().collect();
    for r in resources {
        if let Some(names) = r["aliases"].as_array() {
            for name in names { if !aliases.insert(name.as_str().unwrap()) { return Err("resource.ambiguous_alias".into()); } }
        }
        if r["evidence"].as_array().unwrap().iter().any(|e| !evidence_ids.contains(e.as_str().unwrap())) { return Err("resource.evidence_reference".into()); }
        let mut seen = HashSet::from([r["id"].as_str().unwrap()]);
        let mut parent = r["parent"].as_str();
        while let Some(p) = parent {
            if !map.contains_key(p) || !seen.insert(p) { return Err("resource.parent".into()); }
            parent = map[p]["parent"].as_str();
        }
    }
    let mut routes = HashSet::new();
    let mut signals = HashSet::new();
    for route in value["routes"].as_array().unwrap() {
        let resource = route["resource"].as_str().unwrap();
        if !routes.insert(route["id"].as_str().unwrap()) || !signals.insert((resource, route["signal"].as_str().unwrap())) || !map.contains_key(resource)
            || route["pins"].as_array().unwrap().iter().any(|p| !map.contains_key(p.as_str().unwrap())) { return Err("resource.route".into()); }
    }
    Ok(())
}
pub(crate) fn validate_claims(value: &Value, fields: &HashSet<String>, inputs: &HashSet<String>) -> Result<(), String> {
    schema(value, true)?;
    let mut ids = HashSet::new();
    for t in value["templates"].as_array().unwrap() {
        if !ids.insert(t["id"].as_str().unwrap()) { return Err("resource.duplicate_claim".into()); }
        let mut operands: Vec<&Value> = ["resource", "owner", "discriminator"].iter().filter_map(|k| t.get(k)).collect();
        for key in ["configuration", "signals"] { if let Some(map) = t[key].as_object() { operands.extend(map.values()); } }
        for source in operands {
            let name = source["name"].as_str().unwrap_or("");
            if (source["kind"] == "field" && !fields.contains(name)) || (source["kind"] == "input" && !inputs.contains(name)) { return Err("resource.undeclared_source".into()); }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resource_contract_shared_validation_corpus() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../examples/resource-contract-fixture");
        let load = |path: &str| -> Value { serde_json::from_slice(&std::fs::read(root.join(path)).unwrap()).unwrap() };
        let graph = load("board.json")["resource_graph"].clone();
        let claims = load("libraries/orchard_probe/ck-blocks.json")["blocks"][0]["hardware"]["claims"].clone();
        for case in load("validation-corpus.json").as_array().unwrap() {
            let is_graph = case["target"] == "graph";
            let mut value = if is_graph { graph.clone() } else { claims.clone() };
            if let Some(path) = case["path"].as_str() {
                if path.is_empty() { value = case["value"].clone(); }
                else {
                    let (parent, key) = path.rsplit_once('/').unwrap();
                    let object = value.pointer_mut(parent).unwrap().as_object_mut().unwrap();
                    if case["remove"] == true { object.remove(key); } else { object.insert(key.into(), case["value"].clone()); }
                }
            }
            let result = if is_graph { validate_graph(&value) } else { validate_claims(&value, &HashSet::from(["BUS".into()]), &HashSet::from(["ADDRESS".into()])) };
            assert_eq!(result.is_ok(), case["valid"].as_bool().unwrap(), "{}: {:?}", case["id"], result);
        }
    }
}
