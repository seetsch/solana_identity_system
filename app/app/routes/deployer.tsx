import SceneWithModel from "~/components/3d/SceneWithModel";
import { loadBlobFromLocalStorage } from "../utils/saveBlob";
import { useWallet, useConnection, useAnchorWallet } from "@solana/wallet-adapter-react";
import { clusterApiUrl, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL, Connection } from "@solana/web3.js";
import { useState, useEffect, ChangeEvent } from "react";
import { useFetcher } from "@remix-run/react";
import Header from "~/components/header";
import type { ActionFunctionArgs } from "@remix-run/node";
import * as Tabs from '@radix-ui/react-tabs';
import { NftMetadata } from "~/types/nft";
import * as anchor from "@coral-xyz/anchor";
import minterClient from "~/../../sdk/src/minter";

interface ActionData {
    imageUrl?: string;
}

/**
 * Returns the PublicKey of the treasury address.
 * Works both in the browser (`import.meta.env`) and on the server (`process.env`).
 * Throws a clear error if the env variable is missing.
 */
function getTreasury(): PublicKey {
    const addr =
        (typeof window !== "undefined"
            ? (import.meta as any).env?.VITE_TREASURY_ADDRESS
            : process.env.VITE_TREASURY_ADDRESS) as string | undefined;

    if (!addr) {
        throw new Error(
            "VITE_TREASURY_ADDRESS env variable is missing. " +
            "Add it to your .env or .env.local file."
        );
    }
    return new PublicKey(addr);
}

/** Price per mint in lamports (exact integer for 0.03 SOL) */
const PRICE_LAMPORTS = Math.round(0.001 * LAMPORTS_PER_SOL);


export default function GenerateAvatar() {

    // Generator state
    const [prompt, setPrompt] = useState("");
    const [previewUrl, setPreviewUrl] = useState<string>("");

    // Upload state
    const [uploadedFile, setUploadedFile] = useState<File | null>(null);
    const [uploadedPreviewUrl, setUploadedPreviewUrl] = useState<string>("");

    // --- NFT details entered by the user ---
    const [nftName, setNftName] = useState("");
    const [nftSymbol, setNftSymbol] = useState("");
    const [nftDescription, setNftDescription] = useState("");
    const [nftMaxSupply, setNftMaxSupply] = useState("");
    const [nftMintFee, setNftMintFee] = useState("");

    // Solana wallet and Metaplex setup
    const { publicKey, wallet, sendTransaction } = useWallet();
    const anchorWallet = useAnchorWallet();
    const { connection } = useConnection();

    // Track which tab is active and auto-switch on generation
    const [tabValue, setTabValue] = useState<'upload' | 'generate'>('upload');
    useEffect(() => {
        if (previewUrl) {
            setTabValue('generate');
        }
    }, [previewUrl]);

    const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            setUploadedFile(file);
            setUploadedPreviewUrl(URL.createObjectURL(file));
            setPreviewUrl("");
        }
    };


    // Upload file via backend API endpoint
    async function uploadFile(file: File): Promise<string> {
        const formData = new FormData();
        formData.append("file", file);
        const res = await fetch("/api/upload-metadata", {
            method: "POST",
            body: formData,
        });
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`File upload failed: ${text}`);
        }
        const { files } = await res.json();
        // assume single file upload; pick the first returned URI
        return files[0].uri;
    }

    // Fetcher for generating images without full page reload
    const fetcher = useFetcher<ActionData>();
    useEffect(() => {
        if (fetcher.data?.imageUrl) {
            setPreviewUrl(fetcher.data.imageUrl);
        }
    }, [fetcher.data]);

    const [minting, setMinting] = useState(false);

    const handleDeploy = async () => {
        if (!publicKey || !anchorWallet) return;

        setMinting(true);
        // Upload preview screenshot to IPFS from localStorage
        let previewIpfsUri: string;
        const blobPreview = loadBlobFromLocalStorage();
        if (!blobPreview) {
            throw new Error("No preview image found in localStorage.");
        }
        const filePreview = new File([blobPreview], 'preview.png', { type: blobPreview.type });
        // Upload and extract only the IPFS hash (strip gateway/path)
        const previewIpfsLink = await uploadFile(filePreview);
        const previewIpfsHash = previewIpfsLink.substring(previewIpfsLink.lastIndexOf('/') + 1);
        previewIpfsUri = previewIpfsHash;

        // Upload the GLB model to IPFS if present
        let modelIpfsUri = "";
        if (uploadedFile) {
            const modelIpfsLink = await uploadFile(uploadedFile);
            const modelIpfsHash = modelIpfsLink.substring(modelIpfsLink.lastIndexOf('/') + 1);
            modelIpfsUri = modelIpfsHash;
            console.log("Uploaded model hash:", modelIpfsUri);
        }
        try {
            // Prepare metadata JSON and upload to IPFS via internal API
            const metadata: NftMetadata = {
                name: nftName || `3D Avatar ${Date.now()}`,
                symbol: nftSymbol || "AVA3D",
                description: nftDescription || "A unique 3D avatar NFT generated by Ekza Space",
                image: previewIpfsUri,
                animation_url: modelIpfsUri,
                attributes: [],
                properties: {
                    files: [
                        { uri: previewIpfsUri, type: "image/png" },
                        { uri: modelIpfsUri, type: "model/gltf-binary" },
                    ],
                    category: "vrmodel",
                    creators: [
                        { address: publicKey.toBase58(), share: 100 },
                    ],
                },
            };

            // Upload metadata to IPFS using internal API
            const uploadRes = await fetch("/api/upload-metadata", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(metadata),
            });
            if (!uploadRes.ok) {
                const errorText = await uploadRes.text();
                throw new Error(`Metadata upload failed: ${errorText}`);
            }
            const uploadJson = await uploadRes.json();
            const metadataUri = uploadJson.ipfsHash;
            console.log("Metadata uploaded: ", uploadJson);

            // ── fee ──
            // TODO: batch this transaction
            if (!sendTransaction) {
                alert("Wallet is not connected or cannot send transactions.");
                setMinting(false);
                return;
            }
            const transaction = new Transaction().add(
                SystemProgram.transfer({
                    fromPubkey: publicKey,
                    toPubkey: getTreasury(),
                    lamports: PRICE_LAMPORTS,
                })
            );
            transaction.feePayer = publicKey!;
            transaction.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;

            const paymentSig = await sendTransaction(transaction, connection);
            const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
            await connection.confirmTransaction(
                { signature: paymentSig, blockhash, lastValidBlockHeight },
                "confirmed"
            );

            // ---- Mint on‑chain directly from the browser via our Anchor SDK ----
            try {
                const provider = new anchor.AnchorProvider(connection, anchorWallet as any, anchor.AnchorProvider.defaultOptions());
                const program = new anchor.Program(minterClient.idlJson as any, provider);
                // @ts-ignore
                const minter = minterClient.create(provider, program);

                // Use string-based BN to support full u64 range
                const maxSupplyBn = new anchor.BN(nftMaxSupply || "0", 10);
                const mintFeeLamports = new anchor.BN(Math.round(parseFloat(nftMintFee || "0") * LAMPORTS_PER_SOL));

                const { avatarDataPda, signature: initSig } = await minter.initializeAvatar({
                    ipfsHash: metadataUri,
                    maxSupply: maxSupplyBn,
                    mintingFeePerMint: mintFeeLamports,
                });

                alert(`✅ Avatar collection initialised!\n\nAvatar PDA:\n${avatarDataPda.toBase58()}\n\nTransaction:\nhttps://explorer.solana.com/tx/${initSig}?cluster=devnet`);
            } catch (sdkErr: any) {
                alert("Mint failed via SDK: " + sdkErr.message);
                console.error("SDK mint failed:", sdkErr);
                setMinting(false);
                return;
            }

        } catch (err: any) {
            console.error("Client: Error in handleDeploy:", err);
            alert("Mint failed (client-side exception): " + err.message);
        } finally {
            setMinting(false);
        }
    };

    return (
        <div className="min-h-screen flex flex-col">
            {/* Header with nav + wallet */}
            <Header />

            {/* Main panel */}
            <div className="flex-1 px-8 py-4 bg-white dark:bg-gray-900">
                <Tabs.Root
                    value={tabValue}
                    onValueChange={(value) => {
                        setTabValue(value as 'upload' | 'generate');
                        setPreviewUrl('');
                        setUploadedPreviewUrl('');
                    }}
                    className="flex flex-col items-center space-y-8"
                >
                    <div className="flex items-center justify-center w-full md:w-3/4 mx-auto mb-4">
                        {uploadedFile?.name.match(/\.(glb|vrm)$/i) ? (
                            <div className="w-full max-w-xl mx-auto mb-8" style={{ aspectRatio: "16 / 10", height: "450px" }}>
                                <SceneWithModel file={URL.createObjectURL(uploadedFile)} screenshot={true} />
                            </div>
                        ) : previewUrl || uploadedPreviewUrl ? (
                            <img
                                src={previewUrl || uploadedPreviewUrl}
                                alt="Avatar preview"
                                className="w-2/3 max-w-sm aspect-square object-contain rounded-lg shadow-lg"
                            />
                        ) : (
                            <div className="w-2/3 max-w-sm aspect-square bg-gray-100 dark:bg-gray-800 rounded-lg flex items-center justify-center">
                                <span className="text-gray-500 dark:text-gray-400">
                                    Preview
                                </span>
                            </div>
                        )}
                    </div>
                    <Tabs.List className="flex space-x-4 mb-4">
                        <Tabs.Trigger
                            value="upload"
                            className="px-4 py-2 rounded-lg data-[state=active]:bg-green-500 data-[state=active]:text-white bg-gray-200 dark:bg-gray-700 text-gray-500 dark:text-gray-300 transition-colors"
                        >
                            Upload
                        </Tabs.Trigger>
                        <Tabs.Trigger
                            value="generate"
                            className="px-4 py-2 rounded-lg data-[state=active]:bg-green-500 data-[state=active]:text-white bg-gray-200 dark:bg-gray-700 text-gray-500 dark:text-gray-300 transition-colors"
                        >
                            Generate
                        </Tabs.Trigger>
                    </Tabs.List>

                    <Tabs.Content value="generate" className="w-full flex flex-col space-y-8 items-center">
                        <fetcher.Form method="post" className="w-full flex flex-col items-center space-y-4">
                            <textarea
                                name="prompt"
                                value={prompt}
                                onChange={(e) => setPrompt(e.target.value)}
                                placeholder="Describe the avatar you want…"
                                rows={4}
                                className="w-2/3 max-w-sm bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg px-4 py-2 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-purple-500"
                            />
                            <button
                                onClick={() => alert("Sorry, this feature still in progress.")}
                                type="button"
                                className="w-1/4 px-4 py-2 bg-green-500 text-white font-semibold rounded-lg shadow-md hover:bg-green-600 focus:outline-none focus:ring-4 focus:ring-green-300 transition-colors duration-200"
                            >
                                Generate
                            </button>
                            {!publicKey && (
                                <p className="text-sm text-red-500">
                                    Connect your wallet to generate.
                                </p>
                            )}
                        </fetcher.Form>
                        {/* --- NFT metadata inputs --- */}
                        <input
                            type="text"
                            placeholder="NFT Name"
                            value={nftName}
                            onChange={(e) => setNftName(e.target.value)}
                            className="w-2/3 max-w-sm bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg px-4 py-2 text-gray-900 dark:text-gray-100"
                        />
                        <input
                            type="text"
                            placeholder="Symbol (optional)"
                            value={nftSymbol}
                            onChange={(e) => setNftSymbol(e.target.value)}
                            className="w-2/3 max-w-sm bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg px-4 py-2 text-gray-900 dark:text-gray-100"
                        />
                        <textarea
                            placeholder="Description"
                            rows={3}
                            value={nftDescription}
                            onChange={(e) => setNftDescription(e.target.value)}
                            className="w-2/3 max-w-sm bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg px-4 py-2 text-gray-900 dark:text-gray-100"
                        />
                        <div className="w-2/3 max-w-sm flex items-center space-x-2">
                            <input
                              type="checkbox"
                              className="h-5 w-5 text-blue-600 bg-gray-100 border-gray-300 rounded focus:ring-blue-500 dark:bg-gray-700 dark:border-gray-600"
                              checked={nftMaxSupply === "18446744073709551615"}
                              onChange={(e) =>
                                setNftMaxSupply(e.target.checked ? "18446744073709551615" : "")
                              }
                            />
                            <span className="text-gray-700 dark:text-gray-300">Infinity</span>
                            <input
                              type="text"
                              placeholder="Max supply"
                              value={nftMaxSupply === "18446744073709551615" ? "∞" : nftMaxSupply}
                              onChange={(e) => setNftMaxSupply(e.target.value)}
                              disabled={nftMaxSupply === "18446744073709551615"}
                              className="flex-1 bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg px-4 py-2 text-gray-900 dark:text-gray-100"
                            />
                        </div>
                        <input
                            type="number"
                            placeholder="Mint fee per mint (SOL)"
                            value={nftMintFee}
                            onChange={(e) => setNftMintFee(e.target.value)}
                            className="w-2/3 max-w-sm bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg px-4 py-2 text-gray-900 dark:text-gray-100"
                        />
                        {(previewUrl || uploadedPreviewUrl) && publicKey && (
                            <button
                                onClick={handleDeploy}
                                disabled={minting}
                                className={`w-1/4 px-4 py-2 ${minting ? "bg-gray-400" : "bg-blue-500 hover:bg-blue-600"} text-white font-semibold rounded-lg shadow-md focus:outline-none focus:ring-4 focus:ring-blue-300 transition-colors duration-200`}
                            >
                                {minting ? "Minting..." : "Deploy"}
                            </button>
                        )}
                    </Tabs.Content>

                    <Tabs.Content value="upload" className="w-full flex flex-col space-y-4 items-center">
                        <input
                            type="file"
                            accept=".vrm,.glb,model/gltf-binary"
                            onChange={handleFileChange}
                            className="w-2/3 max-w-sm bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg p-4"
                        />
                        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                            Use a sample models to explore the interface: <a href="https://drive.google.com/drive/folders/11oQ8pwVMV9inSVV9cGceI8xTusDxhPC3?usp=drive_link" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline">download here</a>
                        </p>
                        {/* --- NFT metadata inputs --- */}
                        <input
                            type="text"
                            placeholder="NFT Name"
                            value={nftName}
                            onChange={(e) => setNftName(e.target.value)}
                            className="w-2/3 max-w-sm bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg px-4 py-2 text-gray-900 dark:text-gray-100"
                        />
                        <input
                            type="text"
                            placeholder="Symbol (optional)"
                            value={nftSymbol}
                            onChange={(e) => setNftSymbol(e.target.value)}
                            className="w-2/3 max-w-sm bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg px-4 py-2 text-gray-900 dark:text-gray-100"
                        />
                        <textarea
                            placeholder="Description"
                            rows={3}
                            value={nftDescription}
                            onChange={(e) => setNftDescription(e.target.value)}
                            className="w-2/3 max-w-sm bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg px-4 py-2 text-gray-900 dark:text-gray-100"
                        />
                        <div className="w-2/3 max-w-sm flex items-center space-x-2">
                            <input
                              type="checkbox"
                              className="h-5 w-5 text-blue-600 bg-gray-100 border-gray-300 rounded focus:ring-blue-500 dark:bg-gray-700 dark:border-gray-600"
                              checked={nftMaxSupply === "18446744073709551615"}
                              onChange={(e) =>
                                setNftMaxSupply(e.target.checked ? "18446744073709551615" : "")
                              }
                            />
                            <span className="text-gray-700 dark:text-gray-300">Infinity</span>
                            <input
                              type="text"
                              placeholder="Max supply"
                              value={nftMaxSupply === "18446744073709551615" ? "∞" : nftMaxSupply}
                              onChange={(e) => setNftMaxSupply(e.target.value)}
                              disabled={nftMaxSupply === "18446744073709551615"}
                              className="flex-1 bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg px-4 py-2 text-gray-900 dark:text-gray-100"
                            />
                        </div>
                        <input
                            type="number"
                            placeholder="Mint fee per mint (SOL)"
                            value={nftMintFee}
                            onChange={(e) => setNftMintFee(e.target.value)}
                            className="w-2/3 max-w-sm bg-gray-50 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg px-4 py-2 text-gray-900 dark:text-gray-100"
                        />
                        {(uploadedPreviewUrl || previewUrl) && publicKey && (
                            <button
                                onClick={handleDeploy}
                                disabled={minting}
                                className={`w-1/4 px-4 py-2 ${minting ? "bg-gray-400" : "bg-blue-500 hover:bg-blue-600"} text-white font-semibold rounded-lg shadow-md focus:outline-none focus:ring-4 focus:ring-blue-300 transition-colors duration-200`}
                            >
                                {minting ? "Deploying..." : "Deploy"}
                            </button>
                        )}
                    </Tabs.Content>
                </Tabs.Root>
            </div>
        </div>
    );
}