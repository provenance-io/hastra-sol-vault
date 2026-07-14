import { ethers } from "ethers";

// 1. Define the TypeScript interface for the Chainlink API response
interface ChainlinkStreamReport {
    reportContext: string;
    report: string;
    signatures: string[];
}

interface ChainlinkApiResponse {
    reports: ChainlinkStreamReport[];
}

async function getStreamPrice() {
    const feedId = "0x00076185d4b7a4961db969a90353e84a18a0125388535e6dda0f0faeeb4e8f51";
    const streamApiUrl = `https://api.chain.link/v1/reports?feedID=${feedId}`;

    try {
        console.log("Fetching live signed report from Chainlink Data Streams API...");
        const response = await fetch(streamApiUrl);

        // 2. Cast the JSON data to our explicit interface
        const data = (await response.json()) as ChainlinkApiResponse;

        if (!data.reports || data.reports.length === 0) {
            throw new Error("No active reports found for this Feed ID.");
        }

        const report = data.reports[0];
        const rawReportData = report.report;

        console.log("\n[Success] Retrieved Signed Report Payload!");

        const types = ["bytes32", "uint32", "uint32", "uint192", "uint192", "int192"];
        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(types, rawReportData);

        const rawPrice = decoded[5];
        const observationsTimestamp = decoded[2];

        const formattedPrice = Number(rawPrice) / 1e18;
        const time = new Date(Number(observationsTimestamp) * 1000).toLocaleString();

        console.log(`\n--- Decoded Price Report ---`);
        console.log(`Price:        $${formattedPrice}`);
        console.log(`Observed At:  ${time}`);

    } catch (error) {
        console.error("Failed to retrieve stream price report:", error);
    }
}

getStreamPrice();