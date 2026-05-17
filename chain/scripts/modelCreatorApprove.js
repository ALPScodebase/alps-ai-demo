const hre = require("hardhat");
const { ethers } = hre;

async function main() {
  console.log("[LISTENER] Initializing validation and approval service...");
  const aggregatorAddress = process.env.AGGREGATOR_ADDRESS;
  const [creatorWallet] = await hre.ethers.getSigners();
  const aggregatorContract = (await hre.ethers.getContractAt("Aggregator", aggregatorAddress)).connect(creatorWallet);
  const queueAddress = await aggregatorContract.queue();
  const verifierAddress = await aggregatorContract.verifier();
  const queueContract = await hre.ethers.getContractAt("OracleQueue", queueAddress);
  const verifierContract = await hre.ethers.getContractAt("OracleVerifier", verifierAddress);
  const processingJobs = new Set(); // Prevent duplicate processing

  async function waitForFulfillment(jobId) {
    console.log(`[LISTENER] Awaiting OCR consensus for job #${jobId}...`);
    return new Promise((resolve, reject) => {
      let completionListener;
      const timeout = setTimeout(() => {
        verifierContract.off("JobCompleted", completionListener);
        reject(new Error(`[LISTENER] [ERROR] OCR fulfillment timeout for job #${jobId} (10m)`));
      }, 600000);
      completionListener = (completedId, submitter) => {
        if (completedId.toString() === jobId.toString()) {
          clearTimeout(timeout);
          verifierContract.off("JobCompleted", completionListener);
          console.log(`[LISTENER] Job #${jobId} finalized by Oracle: ${submitter}.`);
          resolve();
        }
      };
      verifierContract.on("JobCompleted", completionListener);
    });
  }

  console.log(`[LISTENER] Listening for LogNewCustomerRequest events...`);

  queueContract.on("LogNewCustomerRequest", async (requestId, ipfsCid, customer, payment, event) => {
      const jobId = requestId.toString();
      // Prevent duplicate handling
      if (processingJobs.has(jobId)) {
        console.log(`[LISTENER] Job #${jobId} already being processed`);
        return;
      }
      processingJobs.add(jobId);
      try {
        console.log("\n=====================================");
        console.log(`[LISTENER] New Job Detected: #${jobId}`);
        console.log(`[LISTENER] Job CID: ${ipfsCid}`);
        console.log(`[LISTENER] Job Customer: ${customer}`);
        console.log(`[LISTENER] Job Payment: ${ethers.formatEther(payment)} ETH`);
        console.log(`[LISTENER] Job TX Hash: ${event.log.transactionHash}`);

        // Approve job
        console.log(`[LISTENER] Approving job #${jobId}...`);
        const tx = await aggregatorContract.approveJob(requestId);
        console.log(`[LISTENER] Approval TX submitted: ${tx.hash}`);
        const receipt = await tx.wait();
        console.log(`[LISTENER] Job #${jobId} approved in block ${receipt.blockNumber}`);

        // Wait for oracle fulfillment
        console.log(`[LISTENER] Waiting for oracle fulfillment for job #${jobId}...`);
        await waitForFulfillment(jobId);
        console.log(`[LISTENER] Workflow completed for job #${jobId}`);
      } catch (error) {
        console.error(`[LISTENER] [ERROR] Job #${jobId}: ${error.message}`);
      } finally {
        processingJobs.delete(jobId);
      }
    }
  );
  // Keep Node process alive
  process.stdin.resume();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});