const { z } = require('zod');

const str = (label, min = 1, max = 120) =>
  z.string({ required_error: `${label} is required.`, invalid_type_error: `${label} must be text.` })
    .trim()
    .min(min, min === 1 ? `${label} is required.` : `${label} must be at least ${min} characters.`)
    .max(max, `${label} is too long.`);

const id = z.coerce.number({ invalid_type_error: 'Invalid id.' }).int('Invalid id.').positive('Invalid id.');
const isRealDate = s => new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const date = z.string({ required_error: 'Choose a date.' }).regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a valid date.').refine(isRealDate, 'Enter a valid date.');
const paise = z.number({ required_error: 'Enter an amount.', invalid_type_error: 'Enter an amount.' })
  .int('Enter an amount in whole paise.').gt(0, 'Enter an amount greater than zero.').lte(10_000_000_000, 'Amount is too large.');
const password = z.string({ required_error: 'Password is required.' })
  .min(8, 'Password needs at least 8 characters.').max(128, 'Password is too long.')
  .regex(/[a-zA-Z]/, 'Password needs at least one letter.').regex(/\d/, 'Password needs at least one number.');
const firstPassword = z.string({ required_error: 'Password is required.' }).min(6, 'Password needs at least 6 characters.').max(128, 'Password is too long.');
const phone = z.string().trim().regex(/^([6-9]\d{9})?$/, 'Enter a valid 10-digit mobile number or leave it blank.').default('');

module.exports = { z, str, id, date, paise, password, firstPassword, phone };
