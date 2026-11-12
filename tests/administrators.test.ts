import { Keypair } from "@solana/web3.js";
import { expect } from "chai";
import { MAX_ADMINISTRATORS, parseAdministrators } from "../scripts/administrators";

describe("scripts/administrators parseAdministrators", () => {
    const keys = Array.from({ length: MAX_ADMINISTRATORS + 1 }, () =>
        Keypair.generate().publicKey.toBase58()
    );
    const [a, b] = keys;

    it("accepts 1 to MAX_ADMINISTRATORS unique keys in order", () => {
        expect(parseAdministrators(a, "admins").map((k) => k.toBase58())).to.deep.equal([a]);
        const max = keys.slice(0, MAX_ADMINISTRATORS);
        expect(parseAdministrators(max.join(","), "admins").map((k) => k.toBase58())).to.deep.equal(max);
    });

    it("ignores surrounding whitespace and empty entries", () => {
        expect(parseAdministrators(` ${a} , ${b},`, "admins").map((k) => k.toBase58())).to.deep.equal([a, b]);
    });

    for (const csv of ["", " ", ",", " , ,"]) {
        it(`rejects an empty list (${JSON.stringify(csv)})`, () => {
            expect(() => parseAdministrators(csv, "admins")).to.throw(
                "admins must contain at least one public key"
            );
        });
    }

    it("rejects duplicate keys", () => {
        expect(() => parseAdministrators(`${a},${b}, ${a}`, "admins")).to.throw(
            `admins contains duplicate key: ${a}`
        );
    });

    it("rejects more than MAX_ADMINISTRATORS keys", () => {
        expect(() => parseAdministrators(keys.join(","), "admins")).to.throw(
            `admins length (${MAX_ADMINISTRATORS + 1}) exceeds maximum ${MAX_ADMINISTRATORS}`
        );
    });

    it("rejects malformed keys", () => {
        expect(() => parseAdministrators(`${a},not-a-key`, "admins")).to.throw();
    });
});
