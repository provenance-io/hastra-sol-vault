use crate::error::*;
use anchor_lang::prelude::*;

#[allow(deprecated)]
use anchor_lang::solana_program::bpf_loader_upgradeable::{UpgradeableLoaderState};

pub fn validate_program_update_authority(
    program_data_account: &UncheckedAccount,
    authority: &Signer,
) -> Result<()> {
    // Deserialize the program data account
    let program_data = program_data_account.try_borrow_data()
        .map_err(|_| CustomErrorCode::InvalidProgramData)?;

    // Parse the upgradeable loader state
    let loader_state = bincode::deserialize::<UpgradeableLoaderState>(&program_data)
        .map_err(|_| CustomErrorCode::InvalidProgramData)?;

    match loader_state {
        UpgradeableLoaderState::ProgramData {
            slot: _,
            upgrade_authority_address,
        } => {
            match upgrade_authority_address {
                Some(update_authority) => {
                    require!(
                        authority.key() == update_authority,
                        CustomErrorCode::InvalidUpgradeAuthority
                    );
                }
                None => {
                    return Err(CustomErrorCode::NoUpgradeAuthority.into());
                }
            }
        }
        _ => return Err(CustomErrorCode::InvalidProgramData.into()),
    }

    Ok(())
}
