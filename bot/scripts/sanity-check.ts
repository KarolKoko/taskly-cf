import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

interface ChecklistResult {
    task: string;
    success: boolean;
    code: string;
    error?: string;
}

// For ageant
class TSSyntaxError extends Error {
    readonly code = 'ERR_TS_SYNTAX';
    constructor(message: string) {
        super(message);
        this.name = 'TypeScriptSyntaxError';
    }
}

class EnvironmentValidationError extends Error {
    readonly code = 'ERR_MISSING_SECRET';
    constructor(message: string) {
        super(message);
        this.name = 'EnvironmentValidationError';
    }
}

class PipelineSanityChecker {
    private results: ChecklistResult[] = [];

    public checkTSsyntax(): void {
        try {
            execSync('npx tsc --noEmit', { stdio: 'pipe' });
            this.results.push({
                task: 'TypeScript Syntax & Types', success: true, code: "OK"
            });
        } catch (error: any) {
            const output = error.stderr?.toString() || error.stdout?.toString() || 'TSC compilation error'
            const tsError = new TSSyntaxError(output);
            this.results.push({
                task: 'TypeScript Syntax & Types',
                success: false,
                error: tsError.message,
                code: tsError.code
            });
        }
    }

    public checkSecretsMatch(): void {
        try {
            const envPath = path.join(process.cwd(), '.env.example');
            if (!fs.existsSync(envPath)) {
                throw new EnvironmentValidationError(`No .env.example in main dir. Failed`)
            }

            const content = fs.readFileSync(envPath, 'utf8');

            const llmOnly = /^LLM_/
            const useLlm = process.env.USE_LLM === 'true'
            const requiredKeys = content
                .split('\n')
                .map(line => line.trim())
                .filter(line => line && !line.startsWith('#'))
                .map(line => line.split('=')[0].trim())
                .filter(key => key.length > 0 && (useLlm || !llmOnly.test(key)));

            const missingKeys: string[] = [];

            requiredKeys.forEach(key => {
                if (!process.env[key] || process.env[key].trim() === '') {
                    missingKeys.push(key);
                }
            });

            if (missingKeys.length > 0) {
                throw new EnvironmentValidationError(`Missing secrets! \n ${missingKeys.join('\n')}`)
            }

            this.results.push({ task: 'Environment & Secrets Match', success: true, code: "OK" });

        } catch (error: any) {
            const errorCode = error instanceof EnvironmentValidationError ? error.code : 'ERR_SYSTEM_UNKNOWN';
            this.results.push({ task: 'Environment & Secrets Match', success: false, error: error.message, code: errorCode });
        }
    }

    public evaluate(): void {
        console.log('--- SANITY PRE-CHECK ---');
        if (this.results.length == 0) {
            console.error("Results arr empty - nothing to check. Fix method call.")
            process.exit(1);
        }
        let hasFailed = false;

        this.results.forEach(res => {
            if (res.success) {
                console.log(`PASSED: ${res.task}`);
            } else {
                console.error(`FAILED: ${res.task}`);
                console.error(`Details: ${res.error}\n`);
                hasFailed = true;
            }
        });

        if (hasFailed) {
            const failedChecks = this.results.filter(r => !r.success);
            console.error('Critical error, after sanity pre-check!');
            let mdReport = `### Sanity Pre-check failed \n`
            mdReport += `Review issues`

            failedChecks.forEach(check => {
                mdReport += `#### ${check.task}\n`;
                mdReport += `\`\`\`text\n${check.error}\n\`\`\`\n\n`;
            });

            mdReport += `\n---\n\n`;
            mdReport += `#### Agent Meta-Data (Error Codes):\n`;
            failedChecks.forEach(check => {
                mdReport += `- \`[${check.code}]\` -> ${check.task}\n`;
            });

            fs.writeFileSync(path.join(process.cwd(), 'sanity-report.md'), mdReport, 'utf-8');

            console.error('Error types: ' + failedChecks.map(c => c.code).join(', '));

            process.exit(1);
        }

        console.log('\n Check passed, moving forward...');
        process.exit(0);
    }
}

// CI pipeline
//  - name: Post Comment to PR on Failure
//       if: failure()
//       uses: marocchino/sticky-pull-request-comment@v2
//       with:
//         header: agent-sanity-status
//         path: sanity-report.md


// - name: Run Sanity Checker Gate
//   run: npm run sanity-check
//   env:
//     DATABASE_URL: ${{ secrets.DATABASE_URL }}
//     OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
//     EXTERNAL_API_KEY: ${{ secrets.EXTERNAL_API_KEY }}


const checker = new PipelineSanityChecker();
checker.checkSecretsMatch()
checker.checkTSsyntax()
checker.evaluate();
