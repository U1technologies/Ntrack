/**
 * Travel partner adapters. Each adapter knows how a partner's booking report is laid out (which
 * column holds the booking reference, value, commission, status...). Partners differ, so nothing
 * here assumes a common format: the generic adapter is configured per import, and named adapters
 * only provide a starting mapping that can be overridden.
 */
export interface BookingColumnMapping {
  bookingRef: string;
  bookingValue: string;
  commission?: string;
  currency?: string;
  status?: string;
  productType?: string;
  destination?: string;
  startDate?: string;
  endDate?: string;
  travelers?: string;
  clickId?: string;
}

export interface TravelAdapter {
  key: string;
  name: string;
  description: string;
  /** False until the mapping is confirmed against the partner's official report specification. */
  specConfirmed: boolean;
  defaultMapping: BookingColumnMapping;
  /** Maps partner status words onto NTrack booking statuses. */
  statusMap: Record<string, 'booked' | 'confirmed' | 'cancelled' | 'completed'>;
}

const COMMON_STATUSES: TravelAdapter['statusMap'] = {
  booked: 'booked',
  pending: 'booked',
  confirmed: 'confirmed',
  approved: 'confirmed',
  completed: 'completed',
  stayed: 'completed',
  travelled: 'completed',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  rejected: 'cancelled',
};

export const TRAVEL_ADAPTERS: TravelAdapter[] = [
  {
    key: 'generic',
    name: 'Generic CSV',
    description: 'Any partner booking report. Map the columns when importing.',
    specConfirmed: true,
    defaultMapping: { bookingRef: 'booking_ref', bookingValue: 'booking_value', commission: 'commission', status: 'status', currency: 'currency', clickId: 'click_id' },
    statusMap: COMMON_STATUSES,
  },
  {
    key: 'hotelzoff',
    name: 'HotelZoff',
    description:
      'Integration-ready adapter for HotelZoff hotel bookings. The column names below are placeholders until HotelZoff shares its report and postback specification; adjust the mapping on import.',
    specConfirmed: false,
    defaultMapping: {
      bookingRef: 'booking_id',
      bookingValue: 'total_amount',
      commission: 'commission',
      currency: 'currency',
      status: 'booking_status',
      destination: 'hotel_city',
      startDate: 'check_in',
      endDate: 'check_out',
      travelers: 'guests',
      clickId: 'affiliate_click_id',
    },
    statusMap: COMMON_STATUSES,
  },
];

export const findAdapter = (key: string) => TRAVEL_ADAPTERS.find((a) => a.key === key) ?? TRAVEL_ADAPTERS[0]!;
