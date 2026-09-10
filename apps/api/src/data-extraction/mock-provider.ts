import { Injectable } from '@nestjs/common';
import type { LlmProvider, RawLlmResponse } from './llm-provider.interface';
import type { RawExtractedInvoiceData } from '@pdf-to-xrechnung/contracts';

const FIXED_RESPONSE: RawExtractedInvoiceData = {
  invoiceNumber: 'RE-MOCK-0001',
  issueDate: '2026-01-01',
  dueDate: '2026-01-31',
  deliveryDate: null,
  currency: 'EUR',
  seller: {
    name: 'Mock Seller GmbH',
    street: 'Musterstrasse 1',
    postalCode: '10115',
    city: 'Berlin',
    countryCode: 'DE',
    vatId: 'DE136695976',
    taxNumber: null,
    electronicAddress: 'mock-seller-routing-id',
    electronicAddressScheme: '0204',
    contactName: 'Anna Mustermann',
    contactEmail: 'rechnung@mock-seller.example',
    contactPhone: '+49 30 1234567',
  },
  buyer: {
    name: 'Mock Buyer AG',
    street: 'Kaeuferweg 5',
    postalCode: '80331',
    city: 'Muenchen',
    countryCode: 'DE',
    vatId: null,
    taxNumber: null,
    electronicAddress: 'mock-buyer-routing-id',
    electronicAddressScheme: '0204',
    contactName: null,
    contactEmail: 'buchhaltung@mock-buyer.example',
    contactPhone: null,
  },
  sellerIban: 'DE89370400440532013000',
  sellerBic: null,
  lineItems: [
    {
      position: 1,
      description: 'Mock consulting service',
      quantity: '1',
      unit: 'Stueck',
      unitPrice: '100.00',
      netAmount: '100.00',
      vatRate: '19',
      vatExemptionReason: null,
    },
  ],
  netTotal: '100.00',
  vatBreakdown: [
    {
      rate: '19',
      base: '100.00',
      amount: '19.00',
      category: null,
      exemptionReason: null,
    },
  ],
  vatTotal: '19.00',
  grossTotal: '119.00',
  paymentTerms: null,
  buyerReference: 'PO-MOCK-0001',
};

@Injectable()
export class MockProvider implements LlmProvider {
  readonly name = 'mock';
  readonly model = 'mock-v1';

  extract(): Promise<RawLlmResponse> {
    return Promise.resolve({
      text: JSON.stringify(FIXED_RESPONSE),
      inputTokens: null,
      outputTokens: null,
      truncated: false,
    });
  }
}
