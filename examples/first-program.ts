import { SqlCockpit } from '@sql-cockpit/sdk';

const client = new SqlCockpit(); // reads SQL_COCKPIT_API_KEY

const account = await client.account.get();
console.log(`Name:  ${account.name}`);
console.log(`Email: ${account.email}`);
console.log(`Plan:  ${account.plan?.name ?? 'no plan'}`);
