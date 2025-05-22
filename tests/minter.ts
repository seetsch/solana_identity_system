import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
    Keypair,
    LAMPORTS_PER_SOL,
    PublicKey,
} from "@solana/web3.js";
import { getAccount as getTokenAccount } from "@solana/spl-token";
import { expect } from "chai";
import { sha256 } from "js-sha256";

// Import your SDK client and related types
import {
    AvatarNftMinterClient,
    getAvatarNftMinterClient,
    PROGRAM_ID as AVATAR_NFT_MINTER_PROGRAM_ID // Assuming PROGRAM_ID is exported
} from "../sdk/src/minter";

describe("avatar-nft-minter", () => {
    // Configure the client to use the local cluster.
    anchor.setProvider(anchor.AnchorProvider.env());
    const provider = anchor.getProvider() as anchor.AnchorProvider;
    const connection = provider.connection;

    // The program instance, directly from anchor.workspace or via SDK
    // const program = anchor.workspace.AvatarNftMinter as Program<AvatarNftMinterIDLType>;

    // SDK Client instance
    let client: AvatarNftMinterClient;

    // Test accounts
    const creator = provider.wallet as anchor.Wallet; // Use the default wallet as the creator
    const minter = Keypair.generate(); // A new keypair for a minter

    // Test data
    const testIpfsHash = "QmPLhiFxQRJEStgFxQvUaETjFZYi7dndkGpwzbWga8ECDo";
    const testIpfsHash2 = "QmZtmowGHPPJeav229rjtr5sNhJgHcrgeh4QXPcNYn7Kom";
    const maxSupply = new BN(100);
    const mintingFeePerMint = new BN(0.01 * LAMPORTS_PER_SOL); // 0.01 SOL
    const zeroMintingFee = new BN(0);

    let avatarDataPda: PublicKey;
    let avatarDataPdaZeroFee: PublicKey;

    before(async () => {
        // Initialize SDK client
        // If your SDK constructor uses anchor.workspace internally, ensure it's available
        // Otherwise, if it needs the program ID, pass it:
        client = getAvatarNftMinterClient(connection, creator, AVATAR_NFT_MINTER_PROGRAM_ID);
        // Or if your SDK gets program from anchor.workspace.AvatarNftMinter
        // client = new AvatarNftMinterClient(provider);


        // Airdrop SOL to the minter for transactions and fees
        const airdropSignature = await connection.requestAirdrop(
            minter.publicKey,
            2 * LAMPORTS_PER_SOL // Airdrop 2 SOL
        );
        const latestBlockhash = await connection.getLatestBlockhash();
        await connection.confirmTransaction({
            blockhash: latestBlockhash.blockhash,
            lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
            signature: airdropSignature,
        });
        console.log(`Airdropped 2 SOL to minter: ${minter.publicKey.toBase58()}`);
    });

    it("Initializes AvatarData correctly", async () => {
        const { signature, avatarDataPda: pda } = await client.initializeAvatar(
            creator.payer,
            testIpfsHash,
            maxSupply,
            mintingFeePerMint
        );
        avatarDataPda = pda;

        console.log("Initialize Avatar TX:", signature);
        expect(signature).to.be.a("string");

        const avatarDataAccount = await client.getAvatarData(avatarDataPda);
        expect(avatarDataAccount).to.not.be.null;
        if (avatarDataAccount) {
            expect(avatarDataAccount.ipfsHash).to.equal(testIpfsHash);
            expect(avatarDataAccount.creator.equals(creator.publicKey)).to.be.true;
            expect(avatarDataAccount.maxSupply.eq(maxSupply)).to.be.true;
            expect(avatarDataAccount.currentSupply.eqn(0)).to.be.true;
            expect(avatarDataAccount.mintingFeePerMint.eq(mintingFeePerMint)).to.be.true;
            expect(avatarDataAccount.totalUnclaimedFees.eqn(0)).to.be.true;
            expect(avatarDataAccount.bump).to.be.a("number");
        }
    });

    it("Initializes a second AvatarData for zero fee testing", async () => {
        const { signature, avatarDataPda: pda } = await client.initializeAvatar(
            creator.payer,
            testIpfsHash2,
            maxSupply, // Can be same or different
            zeroMintingFee
        );
        avatarDataPdaZeroFee = pda;

        console.log("Initialize Avatar (Zero Fee) TX:", signature);
        expect(signature).to.be.a("string");

        const avatarDataAccount = await client.getAvatarData(avatarDataPdaZeroFee);
        expect(avatarDataAccount).to.not.be.null;
        if (avatarDataAccount) {
            expect(avatarDataAccount.ipfsHash).to.equal(testIpfsHash2);
            expect(avatarDataAccount.mintingFeePerMint.eq(zeroMintingFee)).to.be.true;
        }
    });

    it("Fails to initialize AvatarData with invalid IPFS hash (too long)", async () => {
        const longIpfsHash = "Q".repeat(65);
        try {
            await client.initializeAvatar(
                creator.payer,
                longIpfsHash,
                maxSupply,
                mintingFeePerMint
            );
            expect.fail("Should have thrown an error for long IPFS hash");
        } catch (error: any) {
            // console.log("Error details (long hash):", JSON.stringify(error, null, 2));
            expect(error.message).to.include("InvalidIpfsHashLength");
            // Or, if using Anchor 0.29+, error structure is different:
            // expect(error.error.errorCode.code).to.equal("InvalidIpfsHashLength");
        }
    });

    it("Fails to initialize AvatarData if already initialized", async () => {
        try {
            await client.initializeAvatar(
                creator.payer,
                testIpfsHash, // Using the same hash as the first test
                maxSupply,
                mintingFeePerMint
            );
            expect.fail("Should have thrown an error for re-initialization");
        } catch (error: any) {
            // This will likely be a lower-level Solana error "already in use"
            // console.log("Error details (re-init):", JSON.stringify(error, null, 2));
            expect(error.message).to.include("custom program error: 0x0"); // Account_already_initialized or similar
            // For Anchor, this often manifests as a 0x0 if the init fails due to existing account
        }
    });


    describe("With initialized AvatarData (fee applies)", () => {
        const nftName = "My Avatar NFT";
        const nftSymbol = "AVTR";
        const nftUri = `https://arweave.net/${testIpfsHash}/metadata.json`;
        let mintPk: PublicKey;
        let minterTokenAccountPk: PublicKey;

        it("Mints an NFT successfully and pays fee", async () => {
            const initialMinterBalance = await connection.getBalance(minter.publicKey);
            const initialAvatarData = await client.getAvatarData(avatarDataPda);
            expect(initialAvatarData).to.not.be.null;
            if (!initialAvatarData) throw new Error("Avatar data not found for fee test");

            const initialAvatarDataBalance = await connection.getBalance(avatarDataPda);

            const { signature, mintPk: newMintPk, tokenAccountPk: newTokenAccountPk } = await client.mintNft(
                minter, // Signer is minter
                testIpfsHash,
                nftName,
                nftSymbol,
                nftUri
            );
            mintPk = newMintPk;
            minterTokenAccountPk = newTokenAccountPk;

            console.log("Mint NFT TX:", signature);
            expect(signature).to.be.a("string");

            // Check AvatarData account state
            const updatedAvatarData = await client.getAvatarData(avatarDataPda);
            expect(updatedAvatarData).to.not.be.null;
            if (updatedAvatarData) {
                expect(updatedAvatarData.currentSupply.eq(initialAvatarData.currentSupply.add(new BN(1)))).to.be.true;
                expect(updatedAvatarData.totalUnclaimedFees.eq(initialAvatarData.totalUnclaimedFees.add(mintingFeePerMint))).to.be.true;
            }

            // Check minter's token account for the NFT
            const tokenAccountInfo = await getTokenAccount(connection, minterTokenAccountPk);
            expect(tokenAccountInfo.amount).to.equal(BigInt(1));
            expect(tokenAccountInfo.mint.equals(mintPk)).to.be.true;
            expect(tokenAccountInfo.owner.equals(minter.publicKey)).to.be.true;

            // Check balances (approximate due to gas fees)
            const finalMinterBalance = await connection.getBalance(minter.publicKey);
            const finalAvatarDataBalance = await connection.getBalance(avatarDataPda);

            expect(finalMinterBalance).to.be.lessThan(initialMinterBalance - mintingFeePerMint.toNumber());
            expect(finalAvatarDataBalance).to.equal(initialAvatarDataBalance + mintingFeePerMint.toNumber());

            // Optionally: Fetch and verify metadata account (more involved)
            // const [metadataPda] = client.getMetadataPda(mintPk);
            // const metadataAccountInfo = await connection.getAccountInfo(metadataPda);
            // expect(metadataAccountInfo).to.not.be.null;
        });

        it("Mints a second NFT", async () => {
            const { signature } = await client.mintNft(
                minter,
                testIpfsHash,
                "Second Avatar",
                "AVTR2",
                `https://arweave.net/${testIpfsHash}/metadata2.json`
            );
            console.log("Mint Second NFT TX:", signature);
            expect(signature).to.be.a("string");

            const avatarDataAccount = await client.getAvatarData(avatarDataPda);
            expect(avatarDataAccount?.currentSupply.eqn(2)).to.be.true;
            expect(avatarDataAccount?.totalUnclaimedFees.eq(mintingFeePerMint.mul(new BN(2)))).to.be.true;
        });

        it("Creator claims accumulated fees", async () => {
            const avatarDataBeforeClaim = await client.getAvatarData(avatarDataPda);
            expect(avatarDataBeforeClaim).to.not.be.null;
            if (!avatarDataBeforeClaim) throw new Error("Avatar data not found for claim test");

            const feesToClaim = avatarDataBeforeClaim.totalUnclaimedFees;
            expect(feesToClaim.gtn(0)).to.be.true; // Expecting 2 * mintingFeePerMint

            const initialCreatorBalance = await connection.getBalance(creator.publicKey);
            const initialAvatarDataBalance = await connection.getBalance(avatarDataPda);

            const { signature } = await client.claimFee(
                creator.payer, // Signer is creator.payer
                testIpfsHash
            );
            console.log("Claim Fee TX:", signature);
            expect(signature).to.be.a("string");

            const avatarDataAfterClaim = await client.getAvatarData(avatarDataPda);
            expect(avatarDataAfterClaim).to.not.be.null;
            if (avatarDataAfterClaim) {
                expect(avatarDataAfterClaim.totalUnclaimedFees.eqn(0)).to.be.true;
            }

            const finalCreatorBalance = await connection.getBalance(creator.publicKey);
            const finalAvatarDataBalance = await connection.getBalance(avatarDataPda);

            // Creator balance should increase by feesToClaim (minus gas for claim tx)
            // AvatarData PDA balance should decrease by feesToClaim
            expect(finalCreatorBalance).to.be.greaterThan(initialCreatorBalance); // Simplified check
            expect(finalAvatarDataBalance).to.equal(initialAvatarDataBalance - feesToClaim.toNumber());
        });

        it("Fails to claim fee if no fees are available", async () => {
            try {
                await client.claimFee(creator.payer, testIpfsHash);
                expect.fail("Should have thrown an error for no fees to claim");
            } catch (error: any) {
                // console.log("Error details (no fees):", JSON.stringify(error, null, 2));
                expect(error.message).to.include("NoFeesToClaim");
                // expect(error.error.errorCode.code).to.equal("NoFeesToClaim");
            }
        });

        it("Fails to claim fee if not the creator", async () => {
            // First, mint another NFT to accumulate some fees again
            await client.mintNft(minter, testIpfsHash, "NFT for wrong claimer test", "BAD", "uri");
            const avatarData = await client.getAvatarData(avatarDataPda);
            expect(avatarData?.totalUnclaimedFees.gtn(0)).to.be.true;

            const wrongClaimer = Keypair.generate(); // A random keypair
            // Airdrop some SOL to wrongClaimer to pay for tx fees
            const airdropSig = await connection.requestAirdrop(wrongClaimer.publicKey, 0.1 * LAMPORTS_PER_SOL);
            const latestBlockhash = await connection.getLatestBlockhash();
            await connection.confirmTransaction({
                blockhash: latestBlockhash.blockhash,
                lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
                signature: airdropSig,
            });

            try {
                await client.claimFee(wrongClaimer, testIpfsHash); // Attempt claim with wrongClaimer
                expect.fail("Should have thrown an error for unauthorized claimer");
            } catch (error: any) {
                // console.log("Error details (unauthorized):", JSON.stringify(error, null, 2));
                // The error comes from the `has_one = creator` constraint.
                // Anchor typically wraps this in a 2001 error code (ConstraintHasOne)
                // or the specific custom error if it's more direct.
                // In this case, it's `Unauthorized` from the `CustomError` enum.
                expect(error.message).to.include("Unauthorized");
                // expect(error.error.errorCode.code).to.equal("Unauthorized");

            }
            // Creator should still be able to claim
            await client.claimFee(creator.payer, testIpfsHash);
            const avatarDataAfterGoodClaim = await client.getAvatarData(avatarDataPda);
            expect(avatarDataAfterGoodClaim?.totalUnclaimedFees.eqn(0)).to.be.true;
        });
    });

    describe("With initialized AvatarData (zero fee)", () => {
        const nftNameZeroFee = "My Zero Fee NFT";
        const nftSymbolZeroFee = "ZFTR";
        const nftUriZeroFee = `https://arweave.net/${testIpfsHash2}/metadata.json`;

        it("Mints an NFT successfully with zero fee", async () => {
            const initialMinterBalance = await connection.getBalance(minter.publicKey);
            const initialAvatarData = await client.getAvatarData(avatarDataPdaZeroFee);
            expect(initialAvatarData).to.not.be.null;
            if (!initialAvatarData) throw new Error("Avatar data (zero fee) not found");

            const initialAvatarDataBalance = await connection.getBalance(avatarDataPdaZeroFee);

            const { signature, mintPk, tokenAccountPk } = await client.mintNft(
                minter,
                testIpfsHash2,
                nftNameZeroFee,
                nftSymbolZeroFee,
                nftUriZeroFee
            );
            console.log("Mint NFT (Zero Fee) TX:", signature);

            const updatedAvatarData = await client.getAvatarData(avatarDataPdaZeroFee);
            expect(updatedAvatarData).to.not.be.null;
            if (updatedAvatarData) {
                expect(updatedAvatarData.currentSupply.eq(initialAvatarData.currentSupply.add(new BN(1)))).to.be.true;
                expect(updatedAvatarData.totalUnclaimedFees.eq(initialAvatarData.totalUnclaimedFees)).to.be.true; // Should be 0
                expect(updatedAvatarData.totalUnclaimedFees.eqn(0)).to.be.true;
            }

            const tokenAccountInfo = await getTokenAccount(connection, tokenAccountPk);
            expect(tokenAccountInfo.amount).to.equal(BigInt(1));

            const finalAvatarDataBalance = await connection.getBalance(avatarDataPdaZeroFee);
            expect(finalAvatarDataBalance).to.equal(initialAvatarDataBalance); // No fee transferred
        });

        it("Fails to claim fee if minting fee was zero", async () => {
            try {
                await client.claimFee(creator.payer, testIpfsHash2);
                expect.fail("Should have thrown an error as no fees were ever collected");
            } catch (error: any) {
                expect(error.message).to.include("NoFeesToClaim");
                // expect(error.error.errorCode.code).to.equal("NoFeesToClaim");
            }
        });
    });


    it("Fails to mint NFT if max supply is reached", async () => {
        const quickIpfs = "QmMaxSupplyTestHash";
        const smallMaxSupply = new BN(1);
        const { avatarDataPda: pdaMaxSupply } = await client.initializeAvatar(
            creator.payer,
            quickIpfs,
            smallMaxSupply,
            mintingFeePerMint
        );

        // Mint 1 successfully
        await client.mintNft(
            minter,
            quickIpfs,
            "Max Supply Test NFT 1", "MAXS", "uri1"
        );

        const avatarData = await client.getAvatarData(pdaMaxSupply);
        expect(avatarData?.currentSupply.eq(smallMaxSupply)).to.be.true;

        // Try to mint another one - should fail
        try {
            await client.mintNft(
                minter,
                quickIpfs,
                "Max Supply Test NFT 2", "MAXS", "uri2"
            );
            expect.fail("Should have thrown an error for max supply reached");
        } catch (error: any) {
            // console.log("Error details (max supply):", JSON.stringify(error, null, 2));
            expect(error.message).to.include("MaxSupplyReached");
            // expect(error.error.errorCode.code).to.equal("MaxSupplyReached");
        }
    });

    it("Handles fetching non-existent AvatarData", async () => {
        const nonExistentPda = Keypair.generate().publicKey; // A random PDA not initialized
        const avatarData = await client.getAvatarData(nonExistentPda);
        expect(avatarData).to.be.null;
    });
});