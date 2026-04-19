const { PacificaClient } = require('./services/pacifica/client.js');
const client = new PacificaClient({ apiConfigKey: process.env.PF_API_KEY });
async function main() {
    const res = await client.account.getTradeHistory({
        account: process.env.DEFAULT_WALLET_ADDRESS,
        limit: 3
    });
    console.log(JSON.stringify(res.data[0], null, 2));
}
main().catch(console.error);
