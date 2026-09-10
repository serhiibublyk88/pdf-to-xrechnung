import type { VatCategoryCode } from '@pdf-to-xrechnung/contracts';
import { de } from './de';

export const en: typeof de = {
  app: {
    title: 'PDF to XRechnung',
    description:
      'Convert PDF invoices into XRechnung (EN 16931) — checked and correctable before download.',
  },
  demoNotice:
    'Demo mode: fixed sample data is used. Values from your PDF are not extracted.',
  theme: {
    switchToLight: 'Light theme',
    switchToDark: 'Dark theme',
  },
  locale: {
    switchLabel: 'Language',
    de: 'German',
    en: 'English',
  },
  common: {
    loading: 'Loading …',
    retry: 'Retry',
    openInNewTab: 'Open in new tab',
    download: 'Download',
  },
  upload: {
    title: 'Upload invoice',
    dropzoneHint: 'Drag a PDF here or choose a file',
    dropzoneActive: 'Drop file here',
    uploading: 'Uploading …',
    invalidType: 'Only PDF files are supported.',
    tooLarge: (maxMb: number) => `The file is larger than ${maxMb} MB.`,
    deduplicatedNotice: (filename: string) =>
      `This file is already in the list as “${filename}” — highlighted below.`,
    deduplicatedNoticeUnnamed: 'This file is already in your list.',
    listTitle: 'My invoices',
    expiresInMinutes: (minutes: number) => `${minutes} min left`,
    expiresInHours: (hours: number) => `${hours} h left`,
    expiresInHoursMinutes: (hours: number, minutes: number) =>
      `${hours} h ${minutes} min left`,
    expiredNotice: 'Expired',
    emptyTitle: 'Turn a PDF invoice into an XRechnung',
    emptyIntro:
      'The data is read out of the PDF, checked arithmetically and formally, and generated as an XRechnung (EN 16931, CIUS XRechnung 3.0.2). Whatever the checks cannot confirm is not guessed — it is handed back to you to correct.',
    emptyPoints: [
      'PDFs with a text layer and clearly legible scans are supported.',
      'No account, no sign-up.',
      'Document, text and generated XML are deleted after two hours.',
    ],
    groups: {
      needsReview: 'Needs review',
      inProgress: 'In progress',
      ready: 'Done',
      failed: 'Failed',
    },
    delete: {
      action: 'Delete invoice',
      title: 'Delete invoice?',
      body: (filename: string) =>
        `“${filename}” will be deleted together with its PDF and everything generated from it.`,
      confirm: 'Delete',
      cancel: 'Cancel',
      failed: 'The invoice could not be deleted.',
    },
  },
  pipeline: {
    stepOf: (current: number, total: number) => `Step ${current} of ${total}`,
    stage: {
      uploaded: { done: 'Uploaded', active: 'Uploading' },
      text: { done: 'Text read', active: 'Reading text' },
      data: { done: 'Data extracted', active: 'Extracting data' },
      checked: { done: 'Checked', active: 'Checking' },
      generated: {
        done: 'XRechnung generated',
        active: 'Generating XRechnung',
      },
    },
    stageState: {
      done: 'completed',
      active: 'in progress',
      pending: 'pending',
      stopped: 'waiting for your correction',
      failed: 'failed',
    },
    fact: {
      pages: (pageCount: number, sourceType: string) =>
        `${pageCount === 1 ? '1 page' : `${pageCount} pages`} · ${sourceType}`,
      lineItems: (count: number) =>
        count === 1 ? '1 line item found' : `${count} line items found`,
      checks: (passed: number, failed: number) =>
        failed === 0
          ? `All ${passed} checks passed`
          : `${passed} of ${passed + failed} checks passed`,
      kositAccepted: 'Accepted by the official KoSIT validator',
    },
    outcome: {
      running: 'The invoice is being processed.',
      needsReview:
        'The checks found open items in the invoice data. Please correct them.',
      needsReviewMapping:
        'The data is internally consistent but cannot be expressed as an XRechnung. Please correct it.',
      ready: 'The XRechnung has been generated.',
      failed: 'Processing failed.',
    },
  },
  sourceType: {
    NATIVE: 'Text layer',
    OCR: 'OCR (text recognition)',
    UNKNOWN: 'Unknown',
  },
  severity: {
    ERROR: 'Error',
    WARNING: 'Warning',
    INFO: 'Info',
  },
  pipelineStage: {
    'text-extraction': 'Text extraction',
    'data-extraction': 'Data extraction',
    validation: 'Validation',
    generation: 'Generation',
  },
  failure: {
    pdfUnreadable:
      'The PDF text could not be read. The file may be corrupt or password-protected.',
    pdfNoPages: 'The PDF contains no pages.',
    pdfResourceLimit: 'The PDF exceeds the supported processing limits.',
    pdfTooManyPages: (pageCount: number, limit: number) =>
      `The PDF has ${pageCount} pages, exceeding the ${limit}-page limit.`,
    ocrTextTooSparse: (pages: number[]) =>
      `OCR could not recognise enough legible text on ${pages.length === 1 ? `page ${pages[0]}` : `pages ${pages.join(', ')}`}.`,
    ocrConfidenceTooLow: (lowestPageConfidence: number, minimum: number) =>
      `OCR quality (${lowestPageConfidence.toFixed(1)}%) is below the required ${minimum}%.`,
    textTooLong: (charCount: number, limit: number) =>
      `The extracted text has ${charCount} characters, exceeding the ${limit}-character limit.`,
    textExtractionRetriesExhausted:
      'Text extraction could not complete after multiple attempts.',
    llmProviderError:
      'Data extraction could not complete because of a provider error.',
    llmResponseNotJson:
      'The data-extraction response was not valid JSON after one repair attempt.',
    llmResponseSchemaMismatch:
      'The data-extraction response did not match the expected format after one repair attempt.',
    llmResponseTruncated:
      'The data-extraction response was cut off because the invoice was too long.',
    llmNoUsableData:
      'Data extraction returned no usable data. The document is probably not an invoice.',
    dataExtractionRetriesExhausted:
      'Data extraction could not complete after multiple attempts.',
    validationRetriesExhausted:
      'Invoice validation could not complete after multiple attempts.',
    generationRetriesExhausted:
      'XRechnung generation could not complete after multiple attempts.',
  },
  review: {
    backToList: 'Back to overview',
    sourceTitle: 'Source document',
    noFindings: 'No findings.',
    passedLabel: 'Passed',
    expectedLabel: 'Expected',
    actualLabel: 'Actual',
    generalFinding: 'General',
    correctionTitle: 'Correction',
    ocrNotice:
      'This document was read with text recognition. Check every value especially carefully against the original.',
    submitting: 'Submitting …',
    formDisabledNotice: 'This invoice cannot be edited right now.',
    statusTitle: 'Status',
    failureLabel: 'Failure reason',
    deadLetterNotice: (stage: string, failedAt: string) =>
      `Processing failed at "${stage}" on ${failedAt}.`,
    retryButton: 'Retry',
    retryQueuedNotice: 'Retry queued — processing is running again.',
    retryGaveUpNotice:
      'The retry did not change the status. Please reload the page or try again later.',
    downloadXml: 'Download XRechnung',
    evidenceTitle: 'All checks',
    blockingTitle: (count: number) =>
      count === 1
        ? '1 item blocks generation'
        : `${count} items block generation`,
    requiredLabel: 'Required',
    blockingHint: 'Jump to the affected field:',
    formatIssuesTitle:
      'Please fix the input formats first — these values cannot be submitted.',
    hideSource: 'Hide document',
    showSource: 'Show document',
    tabSource: 'Document',
    tabReview: 'Review',
    contactDetails: (party: string) =>
      `Contact and electronic address (${party})`,
    identifiersHint:
      'VAT identifier (BT-31) and tax registration number (BT-32) are two different identifiers. XRechnung requires the VAT identifier.',
    contactHint:
      'Electronic address and scheme are the technical delivery address on the e-invoicing network, not a contact — the scheme says how to read the value (e.g. VAT ID, email). Contact name, phone, and email are the human contact person for questions about this invoice. XRechnung requires a named contact only for the seller (BG-6) — for the buyer, these three fields are optional.',
    selectPlaceholder: 'Please select …',
    unrecognizedOptionLabel: (value: string) => `${value} (not recognized)`,
    expiresLabel: 'Available',
    reviewAndSubmit: 'Review and submit',
    confirmTitle: 'Review and submit',
    confirmChanged: (count: number) =>
      count === 1 ? '1 change' : `${count} changes`,
    confirmNoChanges:
      'Nothing was changed. The data will be checked again unchanged.',
    confirmRecheckedTitle: 'Will be checked again',
    confirmRecheckedHint:
      'These items concern fields you changed. Whether they are resolved is decided by the checks on the server.',
    confirmUntouchedTitle: 'Not edited',
    confirmUntouchedHint:
      'These items concern no changed field and will therefore remain.',
    confirmFinalCheckHint:
      'Before submitting, check all fields against the original document once more — not just the highlighted ones.',
    confirmBack: 'Back to the correction',
    confirmSubmit: 'Submit',
    emptyValue: 'empty',
    submitResultGenerating:
      'Correction accepted — the XRechnung is being generated.',
    submitResultNeedsReview:
      'Correction saved, but errors remain. The findings below are up to date.',
    loadFailedTitle: 'View is not up to date',
    readyDisclaimer:
      'The XRechnung conforms to EN 16931 and was accepted by the official KoSIT validator. That does not verify the data against the PDF — the review above is what does.',
    lineItemsHint:
      'Only remove a line item if it was recognized incorrectly and is not really on the invoice — if a real line item is missing, add it instead.',
    lineItemsLimit: (limit: number) =>
      `At most ${limit} line items are allowed.`,
    addLineItem: 'Add line item',
    removeLineItem: (index: number) => `Remove line item ${index}`,
    vatBreakdownHint:
      'Only remove a VAT rate group if it was recognized incorrectly and is not really on the invoice — if a real group is missing, add it instead.',
    vatBreakdownLimit: (limit: number) =>
      `At most ${limit} VAT rate groups are allowed.`,
    addVatBreakdown: 'Add VAT rate group',
    removeVatBreakdown: (index: number) => `Remove VAT rate group ${index}`,
    positionLabel: (index: number) => `Position ${index}`,
    vatGroupLabel: (index: number) => `VAT rate group ${index}`,
    vatCategoryHint:
      'Pick the tax treatment printed on the invoice for this VAT rate group. A zero rate always needs one.',
    vatCategoryReasonHint:
      'The exemption reason above is the wording printed on the invoice — kept as evidence, shown next to the category you pick.',
    vatCategoryOptions: {
      S: 'Standard rate',
      AE: 'Reverse charge',
      K: 'Intra-community supply',
      G: 'Export outside the EU',
      E: 'Exempt from VAT',
      Z: 'Zero rated',
    },
    vatCategoryResolvedReason: (category: VatCategoryCode): string | null => {
      switch (category) {
        case 'AE':
          return 'Will be sent as: reverse charge — recipient liable for VAT.';
        case 'K':
          return 'Will be sent as: intra-community supply.';
        case 'G':
          return 'Will be sent as: export outside the EU.';
        case 'S':
        case 'E':
        case 'Z':
          return null;
      }
    },
    groups: {
      header: 'Invoice header',
      seller: 'Seller',
      buyer: 'Buyer',
      lineItems: 'Line items',
      vatBreakdown: 'VAT breakdown',
      totals: 'Totals',
    },
  },
  fields: {
    invoiceNumber: 'Invoice number', // BT-1
    issueDate: 'Issue date', // BT-2
    dueDate: 'Due date', // BT-9
    deliveryDate: 'Delivery date', // BT-72 — Leistungsdatum in German invoicing practice
    currency: 'Currency', // BT-5
    sellerIban: 'IBAN', // BT-84
    sellerBic: 'BIC', // BT-86
    netTotal: 'Net total', // BT-106
    vatTotal: 'VAT total', // BT-110
    grossTotal: 'Gross total', // BT-112
    paymentTerms: 'Payment terms', // BT-20
    buyerReference: 'Leitweg-ID', // BT-10, mandatory per BR-DE-15 — kept as the standard's own term
    seller: 'Seller', // BG-4
    buyer: 'Buyer', // BG-7
    lineItems: 'Line items', // BG-25
    vatBreakdown: 'VAT breakdown', // BG-23
  },
  party: {
    name: 'Name', // BT-27 seller / BT-44 buyer
    street: 'Street', // BT-35 seller / BT-50 buyer
    postalCode: 'Postal code', // BT-38 seller / BT-53 buyer
    city: 'City', // BT-37 seller / BT-52 buyer
    countryCode: 'Country', // BT-40 seller / BT-55 buyer
    vatId: 'VAT ID', // BT-31 seller / BT-48 buyer — distinct from taxNumber
    taxNumber: 'Tax number', // BT-32 seller; EN 16931 has no distinct buyer term
    electronicAddress: 'Electronic address', // BT-34 seller / BT-49 buyer
    electronicAddressScheme: 'Electronic address scheme', // BT-34/BT-49 scheme id (BR-62/BR-63)
    contactName: 'Contact name', // BT-41 seller / BT-56 buyer
    contactEmail: 'Email', // BT-43 seller / BT-58 buyer
    contactPhone: 'Phone', // BT-42 seller / BT-57 buyer
  },
  lineItem: {
    position: 'Position', // BT-126
    description: 'Description', // BT-153
    quantity: 'Quantity', // BT-129
    unit: 'Unit', // BT-130
    unitPrice: 'Unit price', // BT-146
    netAmount: 'Net amount', // BT-131
    vatRate: 'VAT rate', // BT-152 — line-level rate, distinct from BT-119
    vatExemptionReason: 'Exemption reason', // no distinct line-level BT in EN 16931
  },
  vatBreakdownField: {
    rate: 'VAT rate', // BT-119 — category-level rate, distinct from BT-152
    base: 'Taxable amount', // BT-116
    amount: 'VAT amount', // BT-117
    category: 'VAT category', // BT-118 — UNCL5305 code, chosen by the reviewer
    exemptionReason: 'Exemption reason (text)', // BT-120
  },
  rules: {
    'arithmetic.line_net':
      'Quantity × unit price must equal the line net amount.',
    'arithmetic.line_sum':
      'The sum of line net amounts must equal the net total.',
    'arithmetic.vat_amount':
      'Taxable amount × VAT rate must equal the VAT amount, per rate group.',
    'arithmetic.vat_base_sum':
      'The sum of taxable amounts must equal the net total.',
    'arithmetic.vat_total': 'The sum of VAT amounts must equal the VAT total.',
    'arithmetic.gross': 'Net total + VAT total must equal the gross total.',
    'format.calendar_date':
      'The date must be a valid calendar date in YYYY-MM-DD format.',
    'format.currency': 'The currency must be a valid ISO 4217 code.',
    'format.iban_checksum': 'The IBAN checksum (mod 97) must be valid.',
    'format.monetary_precision':
      'Printed monetary amounts must have at most two decimal places.',
    'format.vat_id_checksum': 'The VAT ID check digit must be valid.',
    'format.vat_id_syntax':
      'The VAT ID must contain a two-character country prefix and identifier.',
    'format.vat_id_prefix':
      'The VAT ID must start with an allowed country prefix.',
    'format.country_code': 'The country code must be a known ISO 3166-1 code.',
    'format.postal_code_de':
      'When the country is "DE", the postal code must be 5 digits.',
    'format.email': 'The email address must have a valid format.',
    'format.phone': 'The phone number must have a valid format.',
    'format.bic': 'The BIC must be 8 or 11 characters.',
    'format.leitweg_id_checksum': "The Leitweg-ID's check digit must be valid.",
    'mandatory.invoice_number': 'The invoice number must be present.',
    'mandatory.issue_date': 'The issue date must be present.',
    'mandatory.currency': 'The currency must be present.',
    'mandatory.buyer_identity':
      "The buyer's name, postal code, city and country must be present.",
    'mandatory.buyer_reference':
      'The buyer reference (Leitweg-ID) must be present.',
    'mandatory.electronic_address':
      'An electronic address and scheme must be present for both parties.',
    'mandatory.line_amounts': 'Every line item must have a net amount.',
    'mandatory.line_descriptions':
      'Every line item must have a description and a quantity.',
    'mandatory.line_vat_rate_or_exemption':
      'Every line item must have a VAT rate or an exemption reason.',
    'mandatory.monetary_total':
      'Net total, VAT total and gross total must be present.',
    'mandatory.payment_terms':
      'Payment terms or a due date must be present when an amount is due.',
    'mandatory.seller_contact':
      "The seller's contact name, phone and email must be present.",
    'mandatory.seller_identity':
      "The seller's name, postal code, city and country must be present.",
    'mandatory.seller_tax_id':
      "The seller's VAT ID or tax number must be present.",
    'mandatory.vat_breakdown': 'Every VAT rate must have a taxable amount.',
    'mandatory.vat_category':
      'The VAT category must match the VAT rate — 0% needs a category, and any category other than standard rate needs 0%.',
    'mandatory.vat_category_buyer_identity':
      'Reverse charge and intra-community supply require the buyer VAT ID.',
    'mandatory.vat_category_reason':
      'The "Exempt from VAT (§ 4 UStG)" category requires an exemption reason.',
    'mandatory.vat_category_seller_vat_id':
      'Intra-community supply requires the seller VAT ID.',
    'mandatory.vat_rate_or_exemption':
      'A VAT rate and amount, or an exemption reason, must be present.',
    'mandatory.delivery_date': 'The delivery date should be present.',
    'mandatory.party_street': 'The street should be present for both parties.',
    'mandatory.seller_iban': "The seller's IBAN should be present.",
    'plausible.line_count': 'The invoice must contain at least one line item.',
    'plausible.date_order':
      'The delivery date should not be after the issue date.',
    'plausible.date_range':
      'The issue date should fall within a plausible range.',
    'plausible.magnitude': 'The gross total should be under €10,000,000.',
    'plausible.positive_amounts': 'Amounts should not be negative.',
    'plausible.vat_rate': 'The VAT rate should be 19, 7, or 0%.',
    'plausible.zero_vat_reason':
      'A 0% VAT rate should have an exemption reason.',
    'mapping.amount_precision':
      'A monetary amount has more than two decimal places and cannot be mapped.',
    'mapping.currency': 'The currency is outside the supported code list.',
    'mapping.electronic_address':
      'The electronic address is missing or cannot be mapped.',
    'mapping.electronic_address_scheme':
      'The electronic address scheme is outside the supported code list.',
    'mapping.generation_failed': 'XML generation failed unexpectedly.',
    'mapping.invoice_header': 'Invoice header data cannot be mapped.',
    'mapping.line_item': 'A line item cannot be mapped.',
    'mapping.line_unit': "A line item's unit is not in the unit lookup table.",
    'mapping.line_vat_category':
      "A line item's VAT rate cannot be matched to a tax category.",
    'mapping.party_address': "A party's address cannot be mapped.",
    'mapping.party_country_code':
      "A party's country code is outside the supported code list.",
    'mapping.schema': 'The stored data does not satisfy the expected schema.',
    'mapping.seller_tax_id':
      'The seller provided only a tax number; a VAT ID is required.',
    'mapping.vat_breakdown': 'The VAT breakdown cannot be mapped.',
    'mapping.vat_breakdown_category':
      'A VAT rate in the breakdown cannot be matched to a tax category.',
    'schema.extracted_data':
      'The stored extracted data does not satisfy the expected schema.',
    'kosit.unspecified':
      'The KoSIT validator rejected the document without naming a rule.',
  },
  issues: {
    decimal:
      'Please use a dot as the decimal separator and no thousands separator — for example 1234.56.',
    date: 'Please choose a valid date.',
    currency: 'The currency code is three uppercase letters — for example EUR.',
    countryCode: 'The country code is two uppercase letters — for example DE.',
    position: 'The position number must be a whole number greater than 0.',
    thousandsSeparator: (value: string) =>
      `Did you mean ${value.replace('.', '')} rather than "${value}"? The dot counts as a decimal separator here.`,
    ibanChecksum: "The IBAN checksum doesn't match — please check the IBAN.",
    vatIdSyntax:
      'The VAT ID must contain a two-character country prefix and identifier.',
    vatIdPrefix: 'The VAT ID must start with an allowed country prefix.',
    vatIdChecksum:
      "The VAT ID's check digit doesn't match — please check the VAT ID.",
    germanPostalCode: 'A German postal code has five digits.',
    emailFormat: "This doesn't look like a valid email address.",
    phoneFormat:
      'This doesn\'t look like a valid phone number — only digits, "+", spaces, parentheses and hyphens are allowed.',
    bicFormat: "This doesn't look like a valid BIC — 8 or 11 characters.",
    leitwegIdChecksum:
      "The Leitweg-ID's check digit doesn't match — please check the Leitweg-ID.",
    vatCategory:
      'The selected VAT category does not match the VAT rate: standard-rated needs a positive rate, all other categories need 0%.',
    vatCategoryBuyerVatId:
      'A buyer VAT ID is required for reverse charge and intra-community supply.',
    vatCategorySellerVatId:
      'A seller VAT ID is required for intra-community supply.',
    schemaMismatch: 'This value cannot be submitted — please check the entry.',
  },
  errors: {
    notFound: 'This invoice is no longer available.',
    conflict: 'The status changed — refreshing the view.',
    unauthorized: 'The session expired. Please reload the page.',
    payloadTooLarge: 'The file is too large.',
    rateLimited: (seconds: number, budget: string) =>
      `${budget} Please try again in ${seconds} seconds.`,
    budget: {
      upload: 'The upload budget is exhausted.',
      review: 'Too many corrections in a short time.',
      retry: 'Too many retries in a short time.',
      polling: 'Too many requests.',
    },
    badRequest: 'The request was rejected.',
    serverError: 'Server error. Please try again later.',
    networkError: 'Could not reach the server.',
    parseError: 'Unexpected response from the server.',
    genericTitle: 'Something went wrong',
    genericBody: 'Please try again.',
  },
};
