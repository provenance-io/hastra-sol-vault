//! Builds instructions from the Anchor IDLs in `../target/idl`, so the account order, signer and
//! writable flags, discriminators and error codes always match the compiled programs.

use std::collections::HashMap;
use std::str::FromStr;

use serde_json::Value;
use trident_fuzz::fuzzing::*;

#[derive(Clone, Debug)]
pub struct IdlAccount {
    pub name: String,
    pub signer: bool,
    pub writable: bool,
    pub optional: bool,
    address: Option<Pubkey>,
    pda: Option<Value>,
}

#[derive(Clone, Debug)]
pub struct IdlInstruction {
    pub name: String,
    pub discriminator: Vec<u8>,
    pub accounts: Vec<IdlAccount>,
}

pub struct Idl {
    pub program_id: Pubkey,
    pub instructions: Vec<IdlInstruction>,
    errors: HashMap<String, u32>,
    account_discriminators: HashMap<String, Vec<u8>>,
}

/// Accounts supplied by the caller, by IDL account name. Anything not listed is resolved from the
/// IDL (fixed addresses and PDAs whose seeds are constants or other account keys).
pub type Accounts<'a> = &'a [(&'a str, Pubkey)];

impl Idl {
    pub fn load(file: &str) -> Self {
        let path = format!("{}/../target/idl/{file}", env!("CARGO_MANIFEST_DIR"));
        let text = std::fs::read_to_string(&path).unwrap_or_else(|e| {
            panic!("read {path}: {e} (run `anchor build -- --features testing`)")
        });
        let json: Value = serde_json::from_str(&text).expect("IDL is valid JSON");

        let instructions = json["instructions"]
            .as_array()
            .expect("IDL instructions")
            .iter()
            .map(|ix| IdlInstruction {
                name: ix["name"].as_str().unwrap().to_string(),
                discriminator: bytes(&ix["discriminator"]),
                accounts: ix["accounts"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|a| {
                        assert!(
                            a.get("accounts").is_none(),
                            "nested account groups are not supported"
                        );
                        IdlAccount {
                            name: a["name"].as_str().unwrap().to_string(),
                            signer: a["signer"].as_bool().unwrap_or(false),
                            writable: a["writable"].as_bool().unwrap_or(false),
                            optional: a["optional"].as_bool().unwrap_or(false),
                            address: a["address"].as_str().map(|s| Pubkey::from_str(s).unwrap()),
                            pda: a.get("pda").cloned(),
                        }
                    })
                    .collect(),
            })
            .collect();

        let errors = json["errors"]
            .as_array()
            .map(|errs| {
                errs.iter()
                    .map(|e| {
                        (
                            e["name"].as_str().unwrap().to_string(),
                            e["code"].as_u64().unwrap() as u32,
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();

        let account_discriminators = json["accounts"]
            .as_array()
            .map(|accs| {
                accs.iter()
                    .map(|a| {
                        (
                            a["name"].as_str().unwrap().to_string(),
                            bytes(&a["discriminator"]),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();

        Self {
            program_id: Pubkey::from_str(json["address"].as_str().unwrap()).unwrap(),
            instructions,
            errors,
            account_discriminators,
        }
    }

    pub fn instruction(&self, name: &str) -> &IdlInstruction {
        self.instructions
            .iter()
            .find(|ix| ix.name == name)
            .unwrap_or_else(|| panic!("instruction {name} is not in the IDL"))
    }

    /// The instruction whose discriminator starts `data`.
    pub fn instruction_for(&self, data: &[u8]) -> Option<&IdlInstruction> {
        self.instructions
            .iter()
            .find(|ix| data.starts_with(&ix.discriminator))
    }

    /// Custom error code for `name` (e.g. `EpochCapExceeded` -> 6xxx).
    pub fn error(&self, name: &str) -> u32 {
        *self
            .errors
            .get(name)
            .unwrap_or_else(|| panic!("error {name} is not in the IDL"))
    }

    pub fn error_name(&self, code: u32) -> Option<&str> {
        self.errors
            .iter()
            .find(|(_, c)| **c == code)
            .map(|(n, _)| n.as_str())
    }

    pub fn account_discriminator(&self, name: &str) -> &[u8] {
        self.account_discriminators
            .get(name)
            .unwrap_or_else(|| panic!("account {name} is not in the IDL"))
    }

    /// Resolves every account of `name` and serializes `args` (already Borsh-encoded) after the
    /// discriminator.
    pub fn build(&self, name: &str, accounts: Accounts, args: Vec<u8>) -> Instruction {
        let ix = self.instruction(name);
        let metas = self.metas(ix, accounts);
        let mut data = ix.discriminator.clone();
        data.extend(args);
        Instruction::new_with_bytes(self.program_id, &data, metas)
    }

    pub fn metas(&self, ix: &IdlInstruction, accounts: Accounts) -> Vec<AccountMeta> {
        let resolved = self.resolve(ix, accounts);
        ix.accounts
            .iter()
            .map(|a| AccountMeta {
                pubkey: resolved[&a.name],
                is_signer: a.signer,
                is_writable: a.writable,
            })
            .collect()
    }

    fn resolve(&self, ix: &IdlInstruction, accounts: Accounts) -> HashMap<String, Pubkey> {
        let mut resolved: HashMap<String, Pubkey> =
            accounts.iter().map(|(n, k)| (n.to_string(), *k)).collect();
        for (given, _) in accounts {
            assert!(
                ix.accounts.iter().any(|a| a.name == *given),
                "{}: account {given} is not in the IDL",
                ix.name
            );
        }
        // PDA seeds can reference accounts that are themselves PDAs, so resolve until stable.
        loop {
            let mut progressed = false;
            for a in &ix.accounts {
                if resolved.contains_key(&a.name) {
                    continue;
                }
                let key = if let Some(address) = a.address {
                    Some(address)
                } else if a.optional {
                    // Anchor reads the program id in an optional slot as `None`.
                    Some(self.program_id)
                } else {
                    a.pda.as_ref().and_then(|pda| self.derive(pda, &resolved))
                };
                if let Some(key) = key {
                    resolved.insert(a.name.clone(), key);
                    progressed = true;
                }
            }
            if !progressed {
                break;
            }
        }
        for a in &ix.accounts {
            assert!(
                resolved.contains_key(&a.name),
                "{}: account {} must be supplied",
                ix.name,
                a.name
            );
        }
        resolved
    }

    fn derive(&self, pda: &Value, resolved: &HashMap<String, Pubkey>) -> Option<Pubkey> {
        let mut seeds: Vec<Vec<u8>> = Vec::new();
        for seed in pda["seeds"].as_array()? {
            seeds.push(seed_bytes(seed, resolved)?);
        }
        let program = match pda.get("program") {
            None => self.program_id,
            Some(p) => Pubkey::try_from(seed_bytes(p, resolved)?.as_slice()).ok()?,
        };
        let refs: Vec<&[u8]> = seeds.iter().map(Vec::as_slice).collect();
        Some(Pubkey::find_program_address(&refs, &program).0)
    }
}

/// Seeds of kind `const` or `account` (a bare account key). Field paths (`epoch.index`) and `arg`
/// seeds return `None`; those accounts must be supplied by the caller.
fn seed_bytes(seed: &Value, resolved: &HashMap<String, Pubkey>) -> Option<Vec<u8>> {
    match seed["kind"].as_str()? {
        "const" => Some(bytes(&seed["value"])),
        "account" => {
            let path = seed["path"].as_str()?;
            resolved.get(path).map(|k| k.to_bytes().to_vec())
        }
        _ => None,
    }
}

fn bytes(v: &Value) -> Vec<u8> {
    v.as_array()
        .expect("byte array")
        .iter()
        .map(|b| b.as_u64().unwrap() as u8)
        .collect()
}
