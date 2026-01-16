import { expect } from "chai";
import { hexlify, parseUnits, zeroPadBytes } from "ethers";
import { ethers } from "hardhat";

import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard, DepositContract, PredepositGuarantee, StakingVault } from "typechain-types";
import { SSZBLSHelpers } from "typechain-types";

import {
  computeDepositDataRoot,
  ether,
  LocalMerkleTree,
  PDGPolicy,
  prepareLocalMerkleTree,
  toGwei,
  toLittleEndian64,
  ValidatorStage,
} from "lib";
import {
  createVaultWithDashboard,
  ensurePredepositGuaranteeUnpaused,
  getProtocolContext,
  ProtocolContext,
  setupLidoForVaults,
} from "lib/protocol";

import { bailOnFailure, Snapshot } from "test/suite";

describe("Scenario: PDG specific validator side-deposit, prove and top up", () => {
  let ctx: ProtocolContext;
  let originalSnapshot: string;

  let stakingVault: StakingVault;
  let depositContract: DepositContract;
  let dashboard: Dashboard;
  let predepositGuarantee: PredepositGuarantee;

  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let depositor: HardhatEthersSigner;
  let sideDepositor: HardhatEthersSigner;

  // The specific validator pubkey to test, deposited during soft launch
  const VALIDATOR_PUBKEY =
    "0x85b99739ca7fab3129c57a8cf63b2ad2494ddc02b3d26ce2eb07a3a1c67226fdea89c715b7560fd5dc642925356b7dcc";

  // Withdrawal credentials will be set to the vault's WC after vault creation
  let withdrawalCredentials: string;

  // Mock CL tree and proof data
  let mockCLtree: LocalMerkleTree;
  let slot: bigint;

  before(async () => {
    ctx = await getProtocolContext();

    originalSnapshot = await Snapshot.take();

    await ensurePredepositGuaranteeUnpaused(ctx);
    await setupLidoForVaults(ctx);

    [owner, nodeOperator, depositor, sideDepositor] = await ethers.getSigners();

    // Create a vault with dashboard
    // nodeOperator is passed as both nodeOperator and nodeOperatorManager
    ({ stakingVault, dashboard } = await createVaultWithDashboard(
      ctx,
      ctx.contracts.stakingVaultFactory,
      owner,
      nodeOperator,
      nodeOperator, // nodeOperatorManager
    ));

    depositContract = await ethers.getContractAt("DepositContract", await stakingVault.DEPOSIT_CONTRACT());
    predepositGuarantee = ctx.contracts.predepositGuarantee;

    // Get the vault's withdrawal credentials
    withdrawalCredentials = await stakingVault.withdrawalCredentials();

    // Fund the vault for later top-ups
    await dashboard.connect(owner).fund({ value: ether("100") });

    // Initialize mock CL tree for proof generation
    slot = await predepositGuarantee.PIVOT_SLOT();
    // Use GI_FIRST_VALIDATOR_CURR for proving unknown/existing validators
    mockCLtree = await prepareLocalMerkleTree(await predepositGuarantee.GI_FIRST_VALIDATOR_CURR());
  });

  beforeEach(bailOnFailure);
  after(async () => await Snapshot.restore(originalSnapshot));

  function createValidatorContainer(): SSZBLSHelpers.ValidatorStruct {
    return {
      pubkey: VALIDATOR_PUBKEY,
      withdrawalCredentials: withdrawalCredentials,
      effectiveBalance: parseUnits("32", "gwei"),
      slashed: false,
      // Set epochs to valid values (not FAR_FUTURE_EPOCH) to pass the activation eligibility check
      activationEligibilityEpoch: 100000,
      activationEpoch: 100001,
      exitEpoch: 2n ** 64n - 1n, // FAR_FUTURE_EPOCH - validator has not exited
      withdrawableEpoch: 2n ** 64n - 1n, // FAR_FUTURE_EPOCH - validator has not withdrawn
    };
  }

  async function addValidatorAndGenerateWitness(validator: SSZBLSHelpers.ValidatorStruct, slotOffset: number) {
    const { validatorIndex } = await mockCLtree.addValidator(validator);
    const { childBlockTimestamp, beaconBlockHeader } = await mockCLtree.commitChangesToBeaconRoot(
      Number(slot) + slotOffset,
    );
    const proof = await mockCLtree.buildProof(validatorIndex, beaconBlockHeader);

    return {
      proof,
      pubkey: hexlify(validator.pubkey),
      validatorIndex,
      childBlockTimestamp,
      slot: beaconBlockHeader.slot,
      proposerIndex: beaconBlockHeader.proposerIndex,
    };
  }

  it("Should setup: Node Operator configures depositor for PDG", async () => {
    await expect(predepositGuarantee.connect(nodeOperator).setNodeOperatorDepositor(depositor))
      .to.emit(predepositGuarantee, "DepositorSet")
      .withArgs(nodeOperator, depositor, nodeOperator);

    expect(await predepositGuarantee.nodeOperatorDepositor(nodeOperator)).to.equal(depositor);
  });

  it("Should setup: Top up Node Operator balance for predeposit guarantee", async () => {
    await expect(
      predepositGuarantee.connect(nodeOperator).topUpNodeOperatorBalance(nodeOperator, { value: ether("1") }),
    )
      .to.emit(predepositGuarantee, "BalanceToppedUp")
      .withArgs(nodeOperator, nodeOperator, ether("1"));

    expect(await predepositGuarantee.nodeOperatorBalance(nodeOperator)).to.deep.equal([ether("1"), 0n]);
  });

  it("Should setup: Set PDG policy to allow proving", async () => {
    // Set PDG policy to ALLOW_PROVE so we can prove unknown validators
    await expect(dashboard.connect(owner).setPDGPolicy(PDGPolicy.ALLOW_PROVE))
      .to.emit(dashboard, "PDGPolicyEnacted")
      .withArgs(PDGPolicy.ALLOW_PROVE);

    expect(await dashboard.pdgPolicy()).to.equal(PDGPolicy.ALLOW_PROVE);
  });

  it("Side deposit: Validator is deposited directly to deposit contract (bypassing PDG)", async () => {
    const depositAmount = ether("32");

    // Create a deposit with a dummy signature (for side deposit simulation)
    // In real scenario, this would be a valid BLS signature
    const signature = zeroPadBytes("0x00", 96);

    const depositDataRoot = computeDepositDataRoot(
      hexlify(withdrawalCredentials),
      VALIDATOR_PUBKEY,
      hexlify(signature),
      depositAmount,
    );

    // Side deposit directly to the deposit contract
    // This simulates a validator being deposited outside of the PDG flow
    const tx = depositContract
      .connect(sideDepositor)
      .deposit(VALIDATOR_PUBKEY, withdrawalCredentials, signature, depositDataRoot, { value: depositAmount });

    await expect(tx)
      .to.emit(depositContract, "DepositEvent")
      .withArgs(VALIDATOR_PUBKEY, withdrawalCredentials, toLittleEndian64(toGwei(depositAmount)), anyValue, anyValue);

    // Verify the validator is NOT yet known to PDG (stage should be NONE)
    const statusBefore = await predepositGuarantee.validatorStatus(VALIDATOR_PUBKEY);
    expect(statusBefore.stage).to.equal(ValidatorStage.NONE);
  });

  it("Prove: Side-deposited validator is proven via Dashboard.proveUnknownValidatorsToPDG", async () => {
    // Create validator container with the vault's WC
    const validator = createValidatorContainer();

    // Generate proof for the validator (simulating it appearing on beacon chain)
    const witness = await addValidatorAndGenerateWitness(validator, 100);

    // Prove the validator through Dashboard
    // This proves that the side-deposited validator has the correct WC for this vault
    const tx = dashboard.connect(nodeOperator).proveUnknownValidatorsToPDG([witness]);

    await expect(tx)
      .to.emit(predepositGuarantee, "ValidatorProven")
      .withArgs(witness.pubkey, nodeOperator, stakingVault, withdrawalCredentials);

    await expect(tx)
      .to.emit(predepositGuarantee, "ValidatorActivated")
      .withArgs(witness.pubkey, nodeOperator, stakingVault, withdrawalCredentials);

    // Verify the validator status is now ACTIVATED
    const status = await predepositGuarantee.validatorStatus(witness.pubkey);
    expect(status.stage).to.equal(ValidatorStage.ACTIVATED);
    expect(status.stakingVault).to.equal(await stakingVault.getAddress());
    expect(status.nodeOperator).to.equal(nodeOperator.address);
  });

  it("Top up: Proven validator can be topped up via PDG", async () => {
    // Top up amount
    const topUpAmount = ether("1");

    // Top up the validator via PDG
    // This uses vault funds to send additional ETH to the validator
    const tx = predepositGuarantee
      .connect(depositor)
      .topUpExistingValidators([{ pubkey: VALIDATOR_PUBKEY, amount: topUpAmount }]);

    await expect(tx)
      .to.emit(depositContract, "DepositEvent")
      .withArgs(VALIDATOR_PUBKEY, withdrawalCredentials, toLittleEndian64(toGwei(topUpAmount)), anyValue, anyValue);

    // Verify vault balance decreased
    await expect(tx).changeEtherBalance(stakingVault, -topUpAmount);
  });

  it("Validator pubkey format is valid", async () => {
    // Verify the pubkey is correctly formatted (48 bytes = 96 hex chars)
    expect(VALIDATOR_PUBKEY.length).to.equal(2 + 96); // 0x + 96 hex chars
  });
});
